#[cfg(feature = "test-utils")]
use std::sync::OnceLock;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use oauth2::{
    basic::{BasicClient, BasicErrorResponse, BasicErrorResponseType},
    AuthType, AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge,
    PkceCodeVerifier, RedirectUrl, RefreshToken, RequestTokenError, Scope, TokenResponse, TokenUrl,
};
use oauth2_reqwest::ReqwestClient;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
#[cfg(not(feature = "test-utils"))]
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ipc::{AccountIdRequest, AppServices, CommandPayload};
use crate::keychain::Keychain;
use crate::queue::QueueEngine;
use crate::storage::{Account, AccountRepository, Storage};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const PROFILE_PATH: &str = "/users/me/profile";
#[cfg(not(feature = "test-utils"))]
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";

#[cfg(feature = "test-utils")]
fn oauth_endpoint(env_key: &str, default: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| default.to_owned())
}

#[cfg(not(feature = "test-utils"))]
fn oauth_endpoint(_env_key: &str, default: &str) -> String {
    default.to_owned()
}

pub fn client_id() -> Result<String, String> {
    std::env::var("LATENTMAIL_GOOGLE_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("LATENTMAIL_GOOGLE_CLIENT_ID").map(str::to_owned))
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "LATENTMAIL_GOOGLE_CLIENT_ID is not configured".to_owned())
}

pub fn client_secret() -> Option<ClientSecret> {
    std::env::var("LATENTMAIL_GOOGLE_CLIENT_SECRET")
        .ok()
        .or_else(|| option_env!("LATENTMAIL_GOOGLE_CLIENT_SECRET").map(str::to_owned))
        .filter(|secret| !secret.is_empty())
        .map(ClientSecret::new)
}
#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "com.latentmail.refresh-token";
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "com.latentmail.desktop.dev.refresh-token";
const REFRESH_TOKENS: Keychain = Keychain::new(KEYCHAIN_SERVICE);

const ACCESS_TOKEN_EXPIRY_SKEW: ChronoDuration = ChronoDuration::minutes(5);
const DEFAULT_ACCESS_TOKEN_LIFETIME: ChronoDuration = ChronoDuration::hours(1);
const REAUTHENTICATION_STRIKES: u8 = 3;
const LOOPBACK_HOST: &str = "127.0.0.1";
const CALLBACK_REQUEST_BUFFER_BYTES: usize = 8192;

type AccessTokenCache = HashMap<String, (String, DateTime<Utc>)>;

#[derive(Clone)]
pub struct AuthService {
    storage: Storage,
    refresh_failures: Arc<Mutex<HashMap<String, u8>>>,
    access_tokens: Arc<Mutex<AccessTokenCache>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountDto {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub needs_reauthentication: bool,
}

#[derive(Debug)]
pub struct Authorization {
    pub url: String,
    pub state: String,
    pub verifier: PkceCodeVerifier,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailProfile {
    pub email_address: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UserInfo {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub picture: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SaveAccountRequest {
    pub email: String,
    pub refresh_token: String,
    pub target: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProfileUpdate {
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

pub struct CodeExchangeRequest<'a> {
    pub client_id: &'a str,
    pub redirect: &'a str,
    pub code: AuthorizationCode,
    pub verifier: PkceCodeVerifier,
}

struct EnrichProfileInput<'a> {
    access_token: &'a str,
    has_profile_scope: bool,
    account: AccountDto,
}

impl AuthService {
    pub fn new(storage: Storage) -> Self {
        Self {
            storage: storage,
            refresh_failures: Arc::new(Mutex::new(HashMap::new())),
            access_tokens: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn accounts(&self) -> Result<Vec<AccountDto>, String> {
        self.storage
            .run(AccountRepository::list)
            .await
            .map_err(|error| error.to_string())
            .map(|accounts| accounts.into_iter().map(account_dto).collect())
    }

    pub async fn has_account(&self, account_id: &str) -> Result<bool, String> {
        let account_id = account_id.to_owned();
        self.storage
            .run(move |connection| AccountRepository::get(connection, &account_id))
            .await
            .map(|account| account.is_some())
            .map_err(|error| error.to_string())
    }

    pub async fn start<R: Runtime>(
        &self,
        app: AppHandle<R>,
        account_id: Option<String>,
    ) -> Result<(), String> {
        async {
            let client_id = client_id()?;
            let listener =
                string_try!(tokio::net::TcpListener::bind(format!("{LOOPBACK_HOST}:0")).await);
            let port = string_try!(listener.local_addr()).port();
            let redirect = format!("http://{LOOPBACK_HOST}:{port}");
            tracing::info!(target: "auth", "sign-in listening on {redirect}");
            let authorization = authorization(&client_id, &redirect)?;
            open_consent(&app, &authorization.url)?;
            let code = receive_code(listener, &authorization.state).await?;
            tracing::info!(target: "auth", "sign-in received callback, exchanging code");
            let token = exchange_code(CodeExchangeRequest {
                client_id: &client_id,
                redirect: &redirect,
                code: code,
                verifier: authorization.verifier,
            })
            .await?;
            let profile = profile(token.access_token().secret()).await?;
            let refresh = token
                .refresh_token()
                .ok_or_else(|| "Google did not return a refresh token".to_owned())?;
            let account = self
                .save_account(SaveAccountRequest {
                    email: profile.email_address,
                    refresh_token: refresh.secret().to_owned(),
                    target: account_id,
                })
                .await?;

            let has_profile_scope = token_has_scope(&token, "profile");
            let account = self
                .enrich_profile(EnrichProfileInput {
                    access_token: token.access_token().secret(),
                    has_profile_scope: has_profile_scope,
                    account: account,
                })
                .await?;

            string_try!(app.emit(crate::events::ACCOUNT_STATE, account));
            Ok(())
        }
        .await
        .inspect_err(|error: &String| tracing::error!(target: "auth", "sign-in failed: {error}"))
    }

    async fn enrich_profile(&self, input: EnrichProfileInput<'_>) -> Result<AccountDto, String> {
        if !input.has_profile_scope {
            return Ok(input.account);
        }
        match userinfo(input.access_token).await {
            Ok(info) => Ok(self
                .apply_profile(
                    &input.account.id,
                    ProfileUpdate {
                        display_name: info.name,
                        avatar_url: info.picture,
                    },
                )
                .await?
                .unwrap_or(input.account)),
            Err(error) => {
                tracing::warn!(target: "auth", "userinfo fetch failed, keeping placeholder identity: {error}");
                Ok(input.account)
            }
        }
    }

    pub async fn save_account(&self, request: SaveAccountRequest) -> Result<AccountDto, String> {
        let now = chrono::Utc::now().timestamp();
        let SaveAccountRequest {
            email,
            refresh_token,
            target,
        } = request;
        let input = PersistAccountInput {
            email: email,
            target: target,
            now: now,
        };
        let account = self
            .storage
            .run(move |connection| persist_account(connection, input))
            .await
            .map_err(|error| error.to_string())?;
        save_refresh_token(&account.id, &refresh_token)?;
        Ok(account_dto(account))
    }

    pub async fn apply_profile(
        &self,
        account_id: &str,
        update: ProfileUpdate,
    ) -> Result<Option<AccountDto>, String> {
        let account_id = account_id.to_owned();
        let updated = self
            .storage
            .run(move |connection| update_account_profile(connection, &account_id, update))
            .await
            .map_err(|error| error.to_string())?;
        Ok(updated.map(account_dto))
    }

    pub async fn mark_needs_reauthentication<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        account_id: String,
    ) -> Result<(), String> {
        let updated = self
            .storage
            .run(move |connection| flag_account_reauthentication(connection, &account_id))
            .await
            .map_err(|error| error.to_string())?;
        let account = updated.ok_or_else(|| "Unknown account".to_owned())?;
        match app.emit(crate::events::ACCOUNT_STATE, account_dto(account)) {
            Ok(()) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn invalidate_access_token(&self, account_id: &str) {
        if let Ok(mut tokens) = self.access_tokens.lock() {
            tokens.remove(account_id);
        }
    }

    fn cached_access_token(&self, account_id: &str) -> Result<Option<String>, String> {
        let tokens = self
            .access_tokens
            .lock()
            .map_err(|_| "refresh lock poisoned".to_owned())?;
        Ok(tokens
            .get(account_id)
            .filter(|(_, expiry)| Utc::now() + ACCESS_TOKEN_EXPIRY_SKEW < *expiry)
            .map(|(token, _)| token.clone()))
    }

    pub async fn refresh_access_token<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        account_id: &str,
    ) -> Result<String, String> {
        if let Some(token) = self.cached_access_token(account_id)? {
            return Ok(token);
        }
        let failure = match exchange_refresh_token(account_id).await {
            Ok(fresh) => return self.remember_access_token(account_id, fresh),
            Err(failure) => failure,
        };
        if failure.rejects_grant() {
            self.record_rejected_grant(app, account_id).await?;
        }
        Err(failure.into_message())
    }

    fn remember_access_token(
        &self,
        account_id: &str,
        fresh: FreshAccessToken,
    ) -> Result<String, String> {
        self.access_tokens
            .lock()
            .map_err(|_| "refresh lock poisoned".to_owned())?
            .insert(account_id.to_owned(), (fresh.access.clone(), fresh.expiry));
        self.refresh_failures
            .lock()
            .map_err(|_| "refresh lock poisoned".to_owned())?
            .remove(account_id);
        Ok(fresh.access)
    }

    async fn record_rejected_grant<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        account_id: &str,
    ) -> Result<(), String> {
        let strikes = {
            let mut failures = self
                .refresh_failures
                .lock()
                .map_err(|_| "refresh lock poisoned".to_owned())?;
            let count = failures.entry(account_id.to_owned()).or_default();
            *count = count.saturating_add(1);
            *count
        };
        if strikes < REAUTHENTICATION_STRIKES {
            return Ok(());
        }
        self.mark_needs_reauthentication(app, account_id.to_owned())
            .await
    }

    pub async fn remove_account(
        &self,
        queue: &Arc<QueueEngine>,
        account_id: &str,
    ) -> Result<(), String> {
        queue.cancel_account_operations(account_id).await;
        let account_owned = account_id.to_owned();
        let removed = self
            .storage
            .run(move |connection| AccountRepository::delete(connection, &account_owned))
            .await
            .map_err(|error| error.to_string())?;
        if removed == 0 {
            return Err("Unknown account".to_owned());
        }
        delete_refresh_token(account_id)?;
        self.invalidate_access_token(account_id);
        Ok(())
    }
}

struct FreshAccessToken {
    access: String,
    expiry: DateTime<Utc>,
}

enum RefreshFailure {
    GrantRejected(String),
    Other(String),
}

impl RefreshFailure {
    fn from_token_error<E: std::error::Error + 'static>(
        error: RequestTokenError<E, BasicErrorResponse>,
    ) -> Self {
        let message = error.to_string();
        let RequestTokenError::ServerResponse(response) = &error else {
            return Self::Other(message);
        };
        if *response.error() == BasicErrorResponseType::InvalidGrant {
            return Self::GrantRejected(message);
        }
        Self::Other(message)
    }

    fn rejects_grant(&self) -> bool {
        matches!(self, Self::GrantRejected(_))
    }

    fn into_message(self) -> String {
        match self {
            Self::GrantRejected(message) | Self::Other(message) => message,
        }
    }
}

impl From<String> for RefreshFailure {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

async fn exchange_refresh_token(account_id: &str) -> Result<FreshAccessToken, RefreshFailure> {
    let token_url = TokenUrl::new(oauth_endpoint("LATENTMAIL_GOOGLE_TOKEN_URL", TOKEN_URL))
        .map_err(|error| error.to_string())?;
    let mut client = BasicClient::new(ClientId::new(client_id()?))
        .set_auth_type(AuthType::RequestBody)
        .set_token_uri(token_url);
    if let Some(secret) = client_secret() {
        client = client.set_client_secret(secret);
    }
    let token = client
        .exchange_refresh_token(&RefreshToken::new(load_refresh_token(account_id)?))
        .request_async(&ReqwestClient::from(crate::http_client()))
        .await
        .map_err(RefreshFailure::from_token_error)?;
    let lifetime = token
        .expires_in()
        .and_then(|lifetime| ChronoDuration::from_std(lifetime).ok())
        .unwrap_or(DEFAULT_ACCESS_TOKEN_LIFETIME);
    Ok(FreshAccessToken {
        access: token.access_token().secret().to_owned(),
        expiry: Utc::now() + lifetime,
    })
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>, storage: Storage) -> Result<(), String> {
    app.manage(AuthService::new(storage));
    Ok(())
}

pub fn authorization(client_id: &str, redirect: &str) -> Result<Authorization, String> {
    let client = BasicClient::new(ClientId::new(client_id.to_owned()))
        .set_auth_uri(string_try!(AuthUrl::new(AUTH_URL.to_owned())))
        .set_token_uri(string_try!(TokenUrl::new(TOKEN_URL.to_owned())))
        .set_redirect_uri(string_try!(RedirectUrl::new(redirect.to_owned())));
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, state) = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new(
            "https://www.googleapis.com/auth/gmail.modify".to_owned(),
        ))
        .add_scope(Scope::new(
            "https://www.googleapis.com/auth/gmail.labels".to_owned(),
        ))
        .add_scope(Scope::new("openid".to_owned()))
        .add_scope(Scope::new("profile".to_owned()))
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent")
        .set_pkce_challenge(challenge)
        .url();
    Ok(Authorization {
        url: url.to_string(),
        state: state.secret().to_owned(),
        verifier: verifier,
    })
}

pub async fn receive_code(
    listener: tokio::net::TcpListener,
    expected_state: &str,
) -> Result<AuthorizationCode, String> {
    let (mut stream, _) = string_try!(listener.accept().await);
    let mut request = vec![0; CALLBACK_REQUEST_BUFFER_BYTES];
    let bytes = string_try!(stream.read(&mut request).await);
    let target = string_try!(std::str::from_utf8(&request[..bytes]))
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "Invalid OAuth callback".to_owned())?;
    let callback = parse_callback(target, expected_state);
    let message = callback_response_body(callback.is_ok());
    string_try!(
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{message}",
                    message.len()
                )
                .as_bytes(),
            )
            .await
    );
    callback
}

fn callback_response_body(valid: bool) -> &'static str {
    if valid {
        return "Sign-in complete. You can close this tab.";
    }
    "Invalid sign-in response."
}

pub fn parse_callback(target: &str, expected_state: &str) -> Result<AuthorizationCode, String> {
    let url = string_try!(tauri::Url::parse(&format!(
        "http://{LOOPBACK_HOST}{target}"
    )));
    let mut values: HashMap<_, _> = url.query_pairs().into_owned().collect();
    if values
        .get("state")
        .is_none_or(|state| state != expected_state)
    {
        return Err("OAuth state did not match".to_owned());
    }
    values
        .remove("code")
        .map(AuthorizationCode::new)
        .ok_or_else(|| "OAuth callback had no code".to_owned())
}

pub async fn exchange_code(
    request: CodeExchangeRequest<'_>,
) -> Result<
    oauth2::StandardTokenResponse<oauth2::EmptyExtraTokenFields, oauth2::basic::BasicTokenType>,
    String,
> {
    let mut client = BasicClient::new(ClientId::new(request.client_id.to_owned()))
        .set_auth_type(AuthType::RequestBody)
        .set_token_uri(string_try!(TokenUrl::new(oauth_endpoint(
            "LATENTMAIL_GOOGLE_TOKEN_URL",
            TOKEN_URL
        ))))
        .set_redirect_uri(string_try!(RedirectUrl::new(request.redirect.to_owned())));
    if let Some(secret) = client_secret() {
        client = client.set_client_secret(secret);
    }
    client
        .exchange_code(request.code)
        .set_pkce_verifier(request.verifier)
        .request_async(&ReqwestClient::from(crate::http_client()))
        .await
        .map_err(|error| error.to_string())
}

pub async fn profile(access_token: &str) -> Result<GmailProfile, String> {
    crate::http_client()
        .get(oauth_endpoint(
            "LATENTMAIL_GOOGLE_PROFILE_URL",
            &format!("{}{PROFILE_PATH}", crate::gmail::GMAIL_API_BASE_URL),
        ))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())
}

#[cfg(not(feature = "test-utils"))]
pub async fn userinfo(access_token: &str) -> Result<UserInfo, String> {
    crate::http_client()
        .get(oauth_endpoint(
            "LATENTMAIL_GOOGLE_USERINFO_URL",
            USERINFO_URL,
        ))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())
}

#[cfg(feature = "test-utils")]
fn fake_userinfo_store() -> &'static std::sync::Mutex<HashMap<String, Result<UserInfo, String>>> {
    static STORE: OnceLock<std::sync::Mutex<HashMap<String, Result<UserInfo, String>>>> =
        OnceLock::new();
    STORE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[cfg(feature = "test-utils")]
pub fn set_fake_userinfo(access_token: &str, info: UserInfo) {
    fake_userinfo_store()
        .lock()
        .expect("fake userinfo lock poisoned")
        .insert(access_token.to_owned(), Ok(info));
}

#[cfg(feature = "test-utils")]
pub async fn userinfo(access_token: &str) -> Result<UserInfo, String> {
    fake_userinfo_store()
        .lock()
        .expect("fake userinfo lock poisoned")
        .get(access_token)
        .cloned()
        .unwrap_or_else(|| Err("no fake userinfo programmed for this access token".to_owned()))
}

pub fn token_has_scope<EF, TT>(token: &oauth2::StandardTokenResponse<EF, TT>, name: &str) -> bool
where
    EF: oauth2::ExtraTokenFields,
    TT: oauth2::TokenType,
{
    token
        .scopes()
        .is_some_and(|scopes| scopes.iter().any(|scope| scope.to_string().contains(name)))
}

#[cfg(not(feature = "test-utils"))]
fn open_consent<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}
#[cfg(feature = "test-utils")]
fn open_consent<R: Runtime>(_app: &AppHandle<R>, _url: &str) -> Result<(), String> {
    Err("System-browser access is disabled in tests".to_owned())
}

pub fn save_refresh_token(account_id: &str, refresh_token: &str) -> Result<(), String> {
    REFRESH_TOKENS.save(account_id, refresh_token)
}

pub fn load_refresh_token(account_id: &str) -> Result<String, String> {
    REFRESH_TOKENS
        .load(account_id)?
        .ok_or_else(|| "missing refresh token".to_owned())
}

pub fn delete_refresh_token(account_id: &str) -> Result<(), String> {
    REFRESH_TOKENS.clear(account_id)
}

#[cfg(feature = "test-utils")]
pub fn has_refresh_token(account_id: &str) -> bool {
    REFRESH_TOKENS
        .load(account_id)
        .expect("keychain lock poisoned")
        .is_some()
}

pub async fn remove_account_with_cleanup<R: Runtime>(
    services: &AppServices<'_, R>,
    account_id: String,
) -> Result<(), String> {
    let app = services.app();
    let service = services.auth()?;
    let queue = services.queue()?;
    let sync = services.sync()?;
    if !service.has_account(&account_id).await? {
        return Err("Unknown account".to_owned());
    }
    if let Some(ai) = app.try_state::<crate::ai::AiService>() {
        ai.begin_removal(&account_id)?;
        queue.cancel_account_operations(&account_id).await;
        let ai = ai.inner().clone();
        let cleanup_account = account_id.clone();
        sync.enqueue_embedding_barrier(
            crate::sync::EmbeddingJob {
                account_id: &account_id,
                description: "Remove semantic index".to_owned(),
            },
            async move { crate::ai::index::cleanup(&ai, cleanup_account).await },
        )
        .await?;
    }
    service.remove_account(queue.inner(), &account_id).await?;
    tauri::Emitter::emit(
        app,
        crate::events::ACCOUNT_REMOVED,
        serde_json::json!({"accountId":account_id}),
    )
    .map_err(|error| error.to_string())?;
    tauri::Emitter::emit(
        app,
        crate::events::AI_CONFIG,
        serde_json::json!({"accountId":account_id,"removed":true}),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_accounts<R: Runtime>(
    services: AppServices<'_, R>,
) -> Result<Vec<AccountDto>, String> {
    services.auth()?.accounts().await
}

#[tauri::command]
pub async fn begin_sign_in<R: Runtime>(services: AppServices<'_, R>) -> Result<(), String> {
    services.auth()?.start(services.app().clone(), None).await
}

#[tauri::command]
pub async fn begin_reauthentication<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountIdRequest>,
) -> Result<(), String> {
    services
        .auth()?
        .start(services.app().clone(), Some(request.account_id))
        .await
}

#[tauri::command]
pub async fn remove_account<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountIdRequest>,
) -> Result<(), String> {
    remove_account_with_cleanup(&services, request.account_id).await
}

struct PersistAccountInput {
    email: String,
    target: Option<String>,
    now: i64,
}

fn persist_account(
    connection: &rusqlite::Connection,
    input: PersistAccountInput,
) -> rusqlite::Result<Account> {
    let existing = match input.target.as_deref() {
        Some(id) => AccountRepository::get(connection, id)?,
        None => AccountRepository::get_by_email(connection, &input.email)?,
    };
    let email_mismatch = input.target.is_some()
        && existing
            .as_ref()
            .is_some_and(|account| account.email != input.email);
    if email_mismatch {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let id = existing
        .as_ref()
        .map_or_else(|| input.email.clone(), |account| account.id.clone());
    let display_name = existing
        .as_ref()
        .map(|account| account.display_name.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| local_part(&input.email));
    let account = Account {
        id: id,
        email: input.email,
        display_name: display_name,
        avatar_url: None,
        history_id: existing.as_ref().and_then(|value| value.history_id),
        needs_reauthentication: false,
        created_at: existing
            .as_ref()
            .map_or(input.now, |value| value.created_at),
        updated_at: input.now,
    };
    AccountRepository::upsert(connection, &account)?;
    Ok(account)
}

fn update_account_profile(
    connection: &rusqlite::Connection,
    account_id: &str,
    update: ProfileUpdate,
) -> rusqlite::Result<Option<Account>> {
    let Some(mut account) = AccountRepository::get(connection, account_id)? else {
        return Ok(None);
    };
    if let Some(name) = update.display_name.filter(|name| !name.is_empty()) {
        account.display_name = name;
    }
    if update.avatar_url.is_some() {
        account.avatar_url = update.avatar_url;
    }
    account.updated_at = chrono::Utc::now().timestamp();
    AccountRepository::upsert(connection, &account)?;
    Ok(Some(account))
}

fn flag_account_reauthentication(
    connection: &rusqlite::Connection,
    account_id: &str,
) -> rusqlite::Result<Option<Account>> {
    let Some(mut account) = AccountRepository::get(connection, account_id)? else {
        return Ok(None);
    };
    account.needs_reauthentication = true;
    account.updated_at = chrono::Utc::now().timestamp();
    AccountRepository::upsert(connection, &account)?;
    Ok(Some(account))
}

fn local_part(email: &str) -> String {
    email.split('@').next().unwrap_or(email).to_owned()
}

fn account_dto(account: Account) -> AccountDto {
    AccountDto {
        id: account.id,
        email: account.email,
        display_name: account.display_name,
        avatar_url: account.avatar_url,
        needs_reauthentication: account.needs_reauthentication,
    }
}
