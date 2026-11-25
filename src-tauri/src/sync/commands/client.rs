use tauri::{AppHandle, Runtime};

use crate::sync::{queue_bridge::gmail_base_url, SyncEngine};
use crate::{auth::AuthService, gmail::AccountClientConfig};

pub(crate) struct GmailClientDeps<'a, R: Runtime> {
    pub app: &'a AppHandle<R>,
    pub auth: &'a AuthService,
    pub engine: &'a SyncEngine,
}

pub(crate) async fn gmail_client_for<R: Runtime>(
    deps: GmailClientDeps<'_, R>,
    account_id: &str,
) -> Result<crate::gmail::GmailClient, String> {
    let token = deps.auth.refresh_access_token(deps.app, account_id).await?;
    let base_url = gmail_base_url();
    Ok(deps
        .engine
        .gmail_client(AccountClientConfig {
            account_id: account_id,
            access_token: token,
            base_url: base_url,
        })
        .await)
}
