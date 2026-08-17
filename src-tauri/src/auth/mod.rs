#[cfg(feature = "test-utils")]
use std::sync::OnceLock;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use oauth2::{
    basic::BasicClient, AuthType, AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken,
    PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, RefreshToken, Scope, TokenResponse, TokenUrl,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
#[cfg(not(feature = "test-utils"))]
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

macro_rules! string_try {
    ($result:expr) => {
        match $result {
            Ok(value) => value,
            Err(error) => return Err(error.to_string()),
        }
    };
}

use crate::storage::{Account, AccountRepository, Storage};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const PROFILE_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
#[cfg(not(feature = "test-utils"))]
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";

fn oauth_endpoint(env_key: &str, default: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| default.to_owned())
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
#[cfg(not(feature = "test-utils"))]
const KEYCHAIN_SERVICE: &str = "com.latentmail.refresh-token";

const ACCESS_TOKEN_EXPIRY_SKEW: ChronoDuration = ChronoDuration::minutes(5);

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

impl AuthService {
    pub fn new(storage: Storage) -> Self {
        Self {
            storage,
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

    pub async fn start<R: Runtime>(
        &self,
        app: AppHandle<R>,
        account_id: Option<String>,
    ) -> Result<(), String> {
        async {
            let client_id = client_id()?;
            let listener = string_try!(tokio::net::TcpListener::bind("127.0.0.1:0").await);
            let port = string_try!(listener.local_addr()).port();
            let redirect = format!("http://127.0.0.1:{port}");
            tracing::info!(target: "auth", "sign-in listening on {redirect}");
            let authorization = authorization(&client_id, &redirect)?;
            open_consent(&app, &authorization.url)?;
            let code = receive_code(listener, &authorization.state).await?;
            tracing::info!(target: "auth", "sign-in received callback, exchanging code");
            let token = exchange_code(&client_id, &redirect, code, authorization.verifier).await?;
            let profile = profile(token.access_token().secret()).await?;
            let refresh = token
                .refresh_token()
                .ok_or_else(|| "Google did not return a refresh token".to_owned())?;
            let account = self
                .save_account(
                    profile.email_address,
                    refresh.secret().to_owned(),
                    account_id,
                )
                .await?;

            let account = if token_has_scope(&token, "profile") {
                match userinfo(token.access_token().secret()).await {
                    Ok(info) => self
                        .apply_profile(&account.id, info.name, info.picture)
                        .await?
                        .unwrap_or(account),
                    Err(error) => {
                        tracing::warn!(target: "auth", "userinfo fetch failed, keeping placeholder identity: {error}");
                        account
                    }
                }
            } else {
                account
            };

            string_try!(app.emit("account://state", account));
            Ok(())
        }
        .await
        .inspect_err(|error: &String| tracing::error!(target: "auth", "sign-in failed: {error}"))
    }


    pub async fn save_account(
        &self,
        email: String,
        refresh_token: String,
        target: Option<String>,
    ) -> Result<AccountDto, String> {
        let now = chrono::Utc::now().timestamp();
        let email_for_db = email.clone();
        let account = self
            .storage
            .run(move |connection| {
                let existing = match target.as_deref() {
                    Some(id) => AccountRepository::get(connection, id)?,
                    None => AccountRepository::get_by_email(connection, &email_for_db)?,
                };
                if target.is_some()
                    && existing
                        .as_ref()
                        .is_some_and(|account| account.email != email_for_db)
                {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                let id = existing
                    .as_ref()
                    .map_or_else(|| email_for_db.clone(), |account| account.id.clone());

                let display_name = existing
                    .as_ref()
                    .map(|account| account.display_name.clone())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| local_part(&email_for_db));
                let account = Account {
                    id,
                    email: email_for_db,
                    display_name,
                    avatar_url: None,
                    history_id: existing.as_ref().and_then(|value| value.history_id),
                    needs_reauthentication: false,
                    created_at: existing.as_ref().map_or(now, |value| value.created_at),
                    updated_at: now,
                };
                AccountRepository::upsert(connection, &account)?;
                Ok(account)
            })
            .await
            .map_err(|error| error.to_string())?;
        save_refresh_token(&account.id, &refresh_token)?;
        Ok(account_dto(account))
    }


    pub async fn apply_profile(
        &self,
        account_id: &str,
        display_name: Option<String>,
        avatar_url: Option<String>,
    ) -> Result<Option<AccountDto>, String> {
        let account_id = account_id.to_owned();
        let updated = self
            .storage
            .run(move |connection| {
                let Some(mut account) = AccountRepository::get(connection, &account_id)? else {
                    return Ok(None);
                };
                if let Some(name) = display_name.filter(|name| !name.is_empty()) {
                    account.display_name = name;
                }
                if avatar_url.is_some() {
                    account.avatar_url = avatar_url;
                }
                account.updated_at = chrono::Utc::now().timestamp();
                AccountRepository::upsert(connection, &account)?;
                Ok(Some(account))
            })
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
            .run(move |connection| {
                let Some(mut account) = AccountRepository::get(connection, &account_id)? else {
                    return Ok(None);
                };
                account.needs_reauthentication = true;
                account.updated_at = chrono::Utc::now().timestamp();
                AccountRepository::upsert(connection, &account)?;
                Ok(Some(account))
            })
            .await
            .map_err(|error| error.to_string())?;
        let account = updated.ok_or_else(|| "Unknown account".to_owned())?;
        match app.emit("account://state", account_dto(account)) {
            Ok(()) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn invalidate_access_token(&self, account_id: &str) {
        if let Ok(mut tokens) = self.access_tokens.lock() {
            tokens.remove(account_id);
        }
    }

    pub async fn refresh_access_token<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        account_id: &str,
    ) -> Result<String, String> {
        {
            let tokens = self
                .access_tokens
                .lock()
                .map_err(|_| "refresh lock poisoned".to_owned())?;
            if let Some((token, expiry)) = tokens.get(account_id) {
                if Utc::now() + ACCESS_TOKEN_EXPIRY_SKEW < *expiry {
                    return Ok(token.clone());
                }
            }
        }
        let result = async {
            let mut client = BasicClient::new(ClientId::new(client_id()?))
                .set_auth_type(AuthType::RequestBody)
                .set_token_uri(string_try!(TokenUrl::new(oauth_endpoint(
                    "LATENTMAIL_GOOGLE_TOKEN_URL",
                    TOKEN_URL
                ))));
            if let Some(secret) = client_secret() {
                client = client.set_client_secret(secret);
            }
            let token = client
                .exchange_refresh_token(&RefreshToken::new(load_refresh_token(account_id)?))
                .request_async(&reqwest::Client::new())
                .await
                .map_err(|e| e.to_string())?;
            let lifetime = token
                .expires_in()
                .and_then(|std_dur| ChronoDuration::from_std(std_dur).ok())
                .unwrap_or(ChronoDuration::seconds(3600));
            let expiry = Utc::now() + lifetime;
            Ok((token.access_token().secret().to_owned(), expiry))
        }
        .await;
        if let Ok((access, expiry)) = &result {
            self.access_tokens
                .lock()
                .map_err(|_| "refresh lock poisoned".to_owned())?
                .insert(account_id.to_owned(), (access.clone(), *expiry));
            self.refresh_failures
                .lock()
                .map_err(|_| "refresh lock poisoned".to_owned())?
                .remove(account_id);
            return Ok(access.clone());
        }
        let failed = {
            let mut failures = self
                .refresh_failures
                .lock()
                .map_err(|_| "refresh lock poisoned".to_owned())?;
            let count = failures.entry(account_id.to_owned()).or_default();
            *count += 1;
            *count >= 3
        };
        if failed {
            self.mark_needs_reauthentication(app, account_id.to_owned())
                .await?;
        }
        result.map(|(access, _)| access)
    }
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let directory = string_try!(app.path().app_data_dir());
    string_try!(std::fs::create_dir_all(&directory));
    app.manage(AuthService::new(string_try!(Storage::open(
        directory.join("latentmail.sqlite")
    ))));
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
        verifier,
    })
}

pub async fn receive_code(
    listener: tokio::net::TcpListener,
    expected_state: &str,
) -> Result<AuthorizationCode, String> {
    let (mut stream, _) = string_try!(listener.accept().await);
    let mut request = vec![0; 8192];
    let bytes = string_try!(stream.read(&mut request).await);
    let target = string_try!(std::str::from_utf8(&request[..bytes]))
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "Invalid OAuth callback".to_owned())?;
    let callback = parse_callback(target, expected_state);
    let valid = callback.is_ok();
    let message = if valid {
        "Sign-in complete. You can close this tab."
    } else {
        "Invalid sign-in response."
    };
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

pub fn parse_callback(target: &str, expected_state: &str) -> Result<AuthorizationCode, String> {
    let url = string_try!(tauri::Url::parse(&format!("http://127.0.0.1{target}")));
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
    client_id: &str,
    redirect: &str,
    code: AuthorizationCode,
    verifier: PkceCodeVerifier,
) -> Result<
    oauth2::StandardTokenResponse<oauth2::EmptyExtraTokenFields, oauth2::basic::BasicTokenType>,
    String,
> {
    let mut client = BasicClient::new(ClientId::new(client_id.to_owned()))
        .set_auth_type(AuthType::RequestBody)
        .set_token_uri(string_try!(TokenUrl::new(oauth_endpoint(
            "LATENTMAIL_GOOGLE_TOKEN_URL",
            TOKEN_URL
        ))))
        .set_redirect_uri(string_try!(RedirectUrl::new(redirect.to_owned())));
    if let Some(secret) = client_secret() {
        client = client.set_client_secret(secret);
    }
    client
        .exchange_code(code)
        .set_pkce_verifier(verifier)
        .request_async(&reqwest::Client::new())
        .await
        .map_err(|e| e.to_string())
}


pub async fn profile(access_token: &str) -> Result<GmailProfile, String> {
    reqwest::Client::new()
        .get(oauth_endpoint("LATENTMAIL_GOOGLE_PROFILE_URL", PROFILE_URL))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}


#[cfg(not(feature = "test-utils"))]
pub async fn userinfo(access_token: &str) -> Result<UserInfo, String> {
    reqwest::Client::new()
        .get(oauth_endpoint("LATENTMAIL_GOOGLE_USERINFO_URL", USERINFO_URL))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
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


pub fn token_has_scope<EF, TT>(
    token: &oauth2::StandardTokenResponse<EF, TT>,
    name: &str,
) -> bool
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
        .map_err(|e| e.to_string())
}
#[cfg(feature = "test-utils")]
fn open_consent<R: Runtime>(_app: &AppHandle<R>, _url: &str) -> Result<(), String> {
    Err("System-browser access is disabled in tests".to_owned())
}

#[cfg(feature = "test-utils")]
fn fake_keychain() -> &'static Mutex<HashMap<String, String>> {
    static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}
#[cfg(feature = "test-utils")]
pub fn save_refresh_token(account_id: &str, value: &str) -> Result<(), String> {
    fake_keychain()
        .lock()
        .map_err(|_| "keychain lock poisoned".to_owned())?
        .insert(account_id.to_owned(), value.to_owned());
    Ok(())
}
#[cfg(feature = "test-utils")]
pub fn load_refresh_token(account_id: &str) -> Result<String, String> {
    fake_keychain()
        .lock()
        .map_err(|_| "keychain lock poisoned".to_owned())?
        .get(account_id)
        .cloned()
        .ok_or_else(|| "missing refresh token".to_owned())
}
#[cfg(not(feature = "test-utils"))]
pub fn save_refresh_token(account_id: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account_id)
        .map_err(|e| e.to_string())?
        .set_password(value)
        .map_err(|e| e.to_string())
}
#[cfg(not(feature = "test-utils"))]
pub fn load_refresh_token(account_id: &str) -> Result<String, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account_id)
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_accounts(
    service: tauri::State<'_, AuthService>,
) -> Result<Vec<AccountDto>, String> {
    service.accounts().await
}
#[tauri::command]
pub async fn begin_sign_in<R: Runtime>(
    app: AppHandle<R>,
    service: tauri::State<'_, AuthService>,
) -> Result<(), String> {
    service.start(app, None).await
}
#[tauri::command]
pub async fn begin_reauthentication<R: Runtime>(
    app: AppHandle<R>,
    service: tauri::State<'_, AuthService>,
    account_id: String,
) -> Result<(), String> {
    service.start(app, Some(account_id)).await
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
