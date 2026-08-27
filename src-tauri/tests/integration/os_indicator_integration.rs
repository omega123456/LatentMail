use latentmail_lib::os::{
    badge,
    icon::{dot_color, dot_geometry, DotColor},
    indicator::{aggregate, IndicatorState},
    tray,
};
use latentmail_lib::storage::{Account, AccountRepository, Storage};

#[test]
fn indicator_prioritizes_reauthentication_and_caps_the_badge() {
    let state = IndicatorState {
        unread_count: 140,
        needs_reauthentication: true,
    };
    assert_eq!(state.badge().as_deref(), Some("!"));
    assert_eq!(
        state.status_row(),
        "140 unread messages — account needs re-authentication"
    );
    assert!(state.tooltip().contains("account needs re-authentication"));
    assert_eq!(
        tray::menu(&state).rows,
        vec![
            "140 unread messages — account needs re-authentication",
            "Re-authenticate account",
            "Compose New Email",
            "Sync Now",
            "Show window",
            "Quit LatentMail"
        ]
    );
    assert_eq!(
        IndicatorState {
            unread_count: 140,
            needs_reauthentication: false
        }
        .badge()
        .as_deref(),
        Some("99+")
    );
}

#[test]
fn icon_dot_geometry_and_color_are_stable() {
    assert_eq!(dot_geometry(16).radius, 4);
    assert_eq!(dot_geometry(32).center_x, 23);
    assert_eq!(dot_color(false), DotColor::Unread);
    assert_eq!(dot_color(true), DotColor::Reauthentication);
}

#[tokio::test]
async fn aggregate_reads_every_account_and_the_safe_platform_surfaces() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    storage
        .run(|connection| {
            for (id, needs_reauthentication) in [("one", false), ("two", true)] {
                AccountRepository::upsert(
                    connection,
                    &Account {
                        id: id.to_owned(),
                        email: format!("{id}@example.com"),
                        display_name: id.to_owned(),
                        avatar_url: None,
                        history_id: None,
                        needs_reauthentication,
                        created_at: 0,
                        updated_at: 0,
                    },
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        aggregate(&storage).await.unwrap(),
        IndicatorState {
            unread_count: 0,
            needs_reauthentication: true,
        }
    );

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let tray = tray::controller(app.handle());
    tray.initialize().unwrap();
    tray.apply(&IndicatorState::empty());
    badge::controller(app.handle()).apply(&IndicatorState::empty());
}
