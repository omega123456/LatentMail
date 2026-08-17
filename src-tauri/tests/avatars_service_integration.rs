use std::sync::{Arc, Mutex};

use latentmail_lib::avatars::cache::{hash_key, AvatarCache, CacheAnswer, CacheDomain};
use latentmail_lib::avatars::resolver::{set_fake_download, set_fake_txt};
use latentmail_lib::avatars::{
    initialize, read_account_avatar, read_sender_avatar, AvatarEmitter, AvatarService,
};
use latentmail_lib::settings::SettingsService;
use latentmail_lib::storage::{Account, AccountRepository, AvatarCacheRepository, Storage};
use tauri::Manager;

fn app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

fn service() -> (AvatarService, AvatarCache, SettingsService, Storage, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let cache = AvatarCache::new(storage.clone(), directory.path().join("avatar-cache")).unwrap();
    let settings = SettingsService::new(storage.clone());
    let avatar_service = AvatarService::new(cache.clone(), storage.clone(), settings.clone());
    (avatar_service, cache, settings, storage, directory)
}

fn emitter(application: &tauri::App<tauri::test::MockRuntime>) -> Arc<dyn AvatarEmitter> {
    Arc::new(application.handle().clone())
}

fn tiny_svg() -> Vec<u8> {
    br#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="teal"/></svg>"#.to_vec()
}

async fn wait_until<F, Fut>(mut condition: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if condition().await {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "condition never became true within the test budget"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn read_sender_avatar_answers_from_cache_and_schedules_resolution_on_a_miss() {
    let (service, _cache, _settings, _storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);

    set_fake_txt(
        "default._bimi.svc-example.com",
        vec!["v=BIMI1; l=https://cdn.svc-example.com/logo.svg;".to_owned()],
    );
    set_fake_download("https://cdn.svc-example.com/logo.svg", tiny_svg());

    let first = service
        .read_sender_avatar(handle.clone(), "svc-example.com".into())
        .await
        .unwrap();
    assert_eq!(first, None);

    wait_until(|| {
        let service = &service;
        let handle = handle.clone();
        async move {
            service
                .read_sender_avatar(handle, "svc-example.com".into())
                .await
                .unwrap()
                .is_some()
        }
    })
    .await;

    let resolved = service
        .read_sender_avatar(handle.clone(), "svc-example.com".into())
        .await
        .unwrap();
    assert!(resolved.is_some(), "the scheduled resolution must have populated the cache");

    let second = service
        .read_sender_avatar(handle, "svc-example.com".into())
        .await
        .unwrap();
    assert_eq!(second, resolved);
}

#[tokio::test]
async fn read_sender_avatar_records_a_miss_when_no_record_exists() {
    let (service, cache, _settings, _storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);

    let received: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let received_for_listener = Arc::clone(&received);
    {
        use tauri::Listener;
        application
            .handle()
            .listen("avatar://resolved", move |event| {
                *received_for_listener.lock().unwrap() = Some(event.payload().to_owned());
            });
    }

    let first = service
        .read_sender_avatar(handle.clone(), "no-record.svc-example.com".into())
        .await
        .unwrap();
    assert_eq!(first, None);

    wait_until(|| {
        let received = Arc::clone(&received);
        async move { received.lock().unwrap().is_some() }
    })
    .await;

    let key = hash_key("no-record.svc-example.com");
    assert_eq!(
        cache.answer(&key, CacheDomain::Sender).await,
        CacheAnswer::Fresh(None)
    );
    assert_eq!(
        service
            .read_sender_avatar(handle, "no-record.svc-example.com".into())
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn showsenderavatars_off_prevents_the_command_from_scheduling_any_lookup() {
    let (service, cache, settings, _storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);

    settings
        .write("showSenderAvatars".into(), serde_json::json!(false))
        .await
        .unwrap();

    set_fake_txt(
        "default._bimi.gated-domain.example",
        vec!["v=BIMI1; l=https://cdn.gated-domain.example/logo.svg;".to_owned()],
    );
    set_fake_download("https://cdn.gated-domain.example/logo.svg", tiny_svg());

    let answer = service
        .read_sender_avatar(handle, "gated-domain.example".into())
        .await
        .unwrap();
    assert_eq!(answer, None);

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let key = hash_key("gated-domain.example");
    assert_eq!(cache.answer(&key, CacheDomain::Sender).await, CacheAnswer::Stale);
}

#[tokio::test]
async fn an_empty_or_blank_domain_answers_none_immediately() {
    let (service, _cache, _settings, _storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);
    assert_eq!(
        service.read_sender_avatar(handle.clone(), "".into()).await.unwrap(),
        None
    );
    assert_eq!(
        service.read_sender_avatar(handle, "   ".into()).await.unwrap(),
        None
    );
}

#[tokio::test]
async fn an_empty_or_blank_account_id_answers_none_immediately() {
    let (service, _cache, _settings, _storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);
    assert_eq!(
        service.read_account_avatar(handle.clone(), "".into()).await.unwrap(),
        None
    );
    assert_eq!(
        service.read_account_avatar(handle, "   ".into()).await.unwrap(),
        None
    );
}

#[tokio::test]
async fn read_account_avatar_records_a_miss_when_the_photo_download_fails() {
    let (service, cache, _settings, storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);

    let received: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let received_for_listener = Arc::clone(&received);
    {
        use tauri::Listener;
        application
            .handle()
            .listen("avatar://resolved", move |event| {
                *received_for_listener.lock().unwrap() = Some(event.payload().to_owned());
            });
    }
    storage
        .run(|connection| {
            AccountRepository::upsert(
                connection,
                &Account {
                    id: "acct-3".into(),
                    email: "broken-photo@example.com".into(),
                    display_name: "Broken Photo".into(),
                    avatar_url: Some("https://photo.example/missing.png".into()),
                    history_id: None,
                    needs_reauthentication: false,
                    created_at: 1,
                    updated_at: 1,
                },
            )
        })
        .await
        .unwrap();

    assert_eq!(
        service.read_account_avatar(handle, "acct-3".into()).await.unwrap(),
        None
    );

    wait_until(|| {
        let received = Arc::clone(&received);
        async move { received.lock().unwrap().is_some() }
    })
    .await;

    let key = hash_key("acct-3");
    assert_eq!(
        cache.answer(&key, CacheDomain::Account).await,
        CacheAnswer::Fresh(None)
    );
}

#[tokio::test]
async fn read_account_avatar_answers_from_cache_and_schedules_acquisition_on_a_miss() {
    let (service, _cache, _settings, storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);

    set_fake_download("https://photo.example/account.svg", tiny_svg());
    storage
        .run(|connection| {
            AccountRepository::upsert(
                connection,
                &Account {
                    id: "acct-1".into(),
                    email: "me@example.com".into(),
                    display_name: "Me".into(),
                    avatar_url: Some("https://photo.example/account.svg".into()),
                    history_id: None,
                    needs_reauthentication: false,
                    created_at: 1,
                    updated_at: 1,
                },
            )
        })
        .await
        .unwrap();

    let first = service
        .read_account_avatar(handle.clone(), "acct-1".into())
        .await
        .unwrap();
    assert_eq!(first, None);

    wait_until(|| {
        let service = &service;
        let handle = handle.clone();
        async move {
            service
                .read_account_avatar(handle, "acct-1".into())
                .await
                .unwrap()
                .is_some()
        }
    })
    .await;

    let resolved = service
        .read_account_avatar(handle, "acct-1".into())
        .await
        .unwrap();
    assert!(resolved.is_some());
}

#[tokio::test]
async fn read_account_avatar_records_a_miss_when_the_account_has_no_remote_photo_url() {
    let (service, cache, _settings, storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);

    let received: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let received_for_listener = Arc::clone(&received);
    {
        use tauri::Listener;
        application
            .handle()
            .listen("avatar://resolved", move |event| {
                *received_for_listener.lock().unwrap() = Some(event.payload().to_owned());
            });
    }
    storage
        .run(|connection| {
            AccountRepository::upsert(
                connection,
                &Account {
                    id: "acct-2".into(),
                    email: "nophoto@example.com".into(),
                    display_name: "No Photo".into(),
                    avatar_url: None,
                    history_id: None,
                    needs_reauthentication: false,
                    created_at: 1,
                    updated_at: 1,
                },
            )
        })
        .await
        .unwrap();

    assert_eq!(
        service.read_account_avatar(handle, "acct-2".into()).await.unwrap(),
        None
    );

    wait_until(|| {
        let received = Arc::clone(&received);
        async move { received.lock().unwrap().is_some() }
    })
    .await;

    let key = hash_key("acct-2");
    assert_eq!(
        cache.answer(&key, CacheDomain::Account).await,
        CacheAnswer::Fresh(None)
    );
    assert!(
        AvatarCacheRepository::get(&storage.connection().unwrap(), &key)
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn an_unknown_account_id_records_a_miss_without_erroring() {
    let (service, _cache, _settings, _storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);
    assert_eq!(
        service
            .read_account_avatar(handle, "does-not-exist".into())
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn resolution_complete_emits_avatar_resolved_with_pipeline_key_and_outcome() {
    let (service, _cache, _settings, _storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);

    set_fake_txt(
        "default._bimi.emits-event.example",
        vec!["v=BIMI1; l=https://cdn.emits-event.example/logo.svg;".to_owned()],
    );
    set_fake_download("https://cdn.emits-event.example/logo.svg", tiny_svg());

    let received: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let received_for_listener = Arc::clone(&received);
    {
        use tauri::Listener;
        application
            .handle()
            .listen("avatar://resolved", move |event| {
                *received_for_listener.lock().unwrap() = Some(event.payload().to_owned());
            });
    }

    service
        .read_sender_avatar(handle, "emits-event.example".into())
        .await
        .unwrap();

    wait_until(|| {
        let received = Arc::clone(&received);
        async move { received.lock().unwrap().is_some() }
    })
    .await;

    let payload = received
        .lock()
        .unwrap()
        .clone()
        .expect("resolution completion must emit avatar://resolved");
    assert!(payload.contains("\"pipeline\":\"sender\""));
    assert!(payload.contains("\"resolved\":true"));
    assert!(
        payload.contains("\"key\":\"emits-event.example\""),
        "expected the raw domain in the event payload, got: {payload}"
    );
    assert!(!payload.contains(&hash_key("emits-event.example")));
}

#[tokio::test]
async fn resolution_complete_emits_the_raw_account_id_for_the_account_pipeline() {
    let (service, _cache, _settings, storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);

    set_fake_download("https://photo.example/event-account.svg", tiny_svg());
    storage
        .run(|connection| {
            AccountRepository::upsert(
                connection,
                &Account {
                    id: "acct-event".into(),
                    email: "event@example.com".into(),
                    display_name: "Event Account".into(),
                    avatar_url: Some("https://photo.example/event-account.svg".into()),
                    history_id: None,
                    needs_reauthentication: false,
                    created_at: 1,
                    updated_at: 1,
                },
            )
        })
        .await
        .unwrap();

    let received: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let received_for_listener = Arc::clone(&received);
    {
        use tauri::Listener;
        application
            .handle()
            .listen("avatar://resolved", move |event| {
                *received_for_listener.lock().unwrap() = Some(event.payload().to_owned());
            });
    }

    service
        .read_account_avatar(handle, "acct-event".into())
        .await
        .unwrap();

    wait_until(|| {
        let received = Arc::clone(&received);
        async move { received.lock().unwrap().is_some() }
    })
    .await;

    let payload = received
        .lock()
        .unwrap()
        .clone()
        .expect("resolution completion must emit avatar://resolved");
    assert!(payload.contains("\"pipeline\":\"account\""));
    assert!(
        payload.contains("\"key\":\"acct-event\""),
        "expected the raw account id in the event payload, got: {payload}"
    );
    assert!(!payload.contains(&hash_key("acct-event")));
}

#[tokio::test]
async fn concurrent_requests_for_the_same_domain_collapse_through_the_full_service() {
    let (service, _cache, _settings, _storage, _directory) = service();
    let application = app();
    let handle = emitter(&application);

    set_fake_txt(
        "default._bimi.collapse.example",
        vec!["v=BIMI1; l=https://cdn.collapse.example/logo.svg;".to_owned()],
    );
    set_fake_download("https://cdn.collapse.example/logo.svg", tiny_svg());

    let first = service.read_sender_avatar(handle.clone(), "collapse.example".into());
    let second = service.read_sender_avatar(handle.clone(), "collapse.example".into());
    let (first, second) = tokio::join!(first, second);
    assert_eq!(first.unwrap(), None);
    assert_eq!(second.unwrap(), None);

    wait_until(|| {
        let service = &service;
        let handle = handle.clone();
        async move {
            service
                .read_sender_avatar(handle, "collapse.example".into())
                .await
                .unwrap()
                .is_some()
        }
    })
    .await;
}

#[tokio::test]
async fn the_tauri_commands_delegate_to_the_service() {
    let (service, _cache, _settings, _storage, _directory) = service();
    let application = app();
    application.manage(service);

    let sender = read_sender_avatar(
        application.handle().clone(),
        application.state(),
        "command-path.example".into(),
    )
    .await
    .unwrap();
    assert_eq!(sender, None);

    let account = read_account_avatar(
        application.handle().clone(),
        application.state(),
        "unknown-account".into(),
    )
    .await
    .unwrap();
    assert_eq!(account, None);
}

#[test]
fn initialize_creates_the_avatar_cache_directory_and_manages_service_state() {
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("APPDATA", home.path());
    std::env::set_var("XDG_DATA_HOME", home.path());

    let application = app();
    let storage_directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(storage_directory.path().join("mail.sqlite")).unwrap();
    application.manage(SettingsService::new(storage));

    initialize(application.handle()).unwrap();

    assert!(application.try_state::<AvatarService>().is_some());
}

#[test]
fn initialize_surfaces_a_readable_error_when_the_database_path_is_unusable() {
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("APPDATA", home.path());
    std::env::set_var("XDG_DATA_HOME", home.path());

    let application = app();
    let storage_directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(storage_directory.path().join("mail.sqlite")).unwrap();
    application.manage(SettingsService::new(storage));

    let data_directory = application.handle().path().app_data_dir().unwrap();
    std::fs::create_dir_all(data_directory.join("latentmail.sqlite")).unwrap();

    assert!(initialize(application.handle()).is_err());
}

#[test]
fn avatar_commands_are_reachable_through_real_ipc_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let cache =
        AvatarCache::new(storage.clone(), directory.path().join("avatar-cache")).unwrap();
    let app = latentmail_lib::ipc::register(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AvatarService::new(
        cache,
        storage.clone(),
        SettingsService::new(storage),
    ));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let invoke = |cmd: &str, body: serde_json::Value| {
        tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap()
    };

    assert_eq!(
        invoke(
            "read_sender_avatar",
            serde_json::json!({ "domain": "example.com" })
        ),
        serde_json::Value::Null
    );
    assert_eq!(
        invoke(
            "read_account_avatar",
            serde_json::json!({ "accountId": "unknown" })
        ),
        serde_json::Value::Null
    );
}
