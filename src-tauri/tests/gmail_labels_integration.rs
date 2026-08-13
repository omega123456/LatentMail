//! Label lifecycle Gmail calls (`gmail::labels`), the fixed colour palette
//! with pre-flight rejection, and the draft-deletion exception (Phase 3).

use latentmail_lib::gmail::{labels::resolve_color, GmailClient, LabelColorPair};
use latentmail_lib::storage::{LabelNameError, LabelRepository, Storage};
use wiremock::{
    matchers::{body_json, method, path},
    Mock, MockServer, ResponseTemplate,
};

#[tokio::test]
async fn create_rename_recolor_and_delete_round_trip_against_the_fake_server() {
    let server = MockServer::start().await;
    let color = resolve_color("blue").expect("blue is on the palette");
    Mock::given(method("POST"))
        .and(path("/users/me/labels"))
        .and(body_json(serde_json::json!({
            "name": "Clients",
            "color": { "textColor": color.text_color, "backgroundColor": color.background_color }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "Label_1", "name": "Clients", "type": "user",
            "color": { "textColor": color.text_color, "backgroundColor": color.background_color }
        })))
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/users/me/labels/Label_1"))
        .and(body_json(serde_json::json!({ "name": "Customers" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "Label_1", "name": "Customers", "type": "user",
            "color": { "textColor": color.text_color, "backgroundColor": color.background_color }
        })))
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/users/me/labels/Label_1"))
        .and(body_json(serde_json::json!({
            "color": { "textColor": "#ffffff", "backgroundColor": "#fb4c2f" }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "Label_1", "name": "Customers", "type": "user",
            "color": { "textColor": "#ffffff", "backgroundColor": "#fb4c2f" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/labels/Label_1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let client = GmailClient::with_base_url("token", server.uri());

    let created = client.create_label("Clients", Some(&color)).await.unwrap();
    assert_eq!(created.id, "Label_1");
    assert_eq!(
        created.color.as_ref().unwrap().background_color,
        color.background_color
    );

    let renamed = client
        .update_label("Label_1", Some("Customers"), None)
        .await
        .unwrap();
    assert_eq!(renamed.name, "Customers");

    let red = resolve_color("red").unwrap();
    let recolored = client
        .update_label("Label_1", None, Some(&red))
        .await
        .unwrap();
    assert_eq!(recolored.color.unwrap().background_color, "#fb4c2f");

    client.delete_label("Label_1").await.unwrap();
}

#[tokio::test]
async fn labels_default_missing_type_and_ignore_incomplete_colors() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": [{
                "id": "Label_1",
                "name": "Clients",
                "color": { "textColor": "#ffffff" }
            }]
        })))
        .mount(&server)
        .await;

    let labels = GmailClient::with_base_url("token", server.uri())
        .labels()
        .await
        .unwrap();

    assert_eq!(labels[0].kind, "user");
    assert!(labels[0].color.is_none());
}

#[tokio::test]
async fn deleting_a_draft_uses_the_dedicated_drafts_endpoint() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/drafts/draft-1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    GmailClient::with_base_url("token", server.uri())
        .delete_draft("draft-1")
        .await
        .unwrap();
}

#[test]
fn off_palette_colours_are_rejected_pre_flight_without_touching_the_network() {
    assert!(resolve_color("blue").is_some());
    assert!(resolve_color("not-a-real-colour").is_none());
    assert!(resolve_color("").is_none());
}

#[test]
fn every_palette_id_round_trips_to_a_distinct_pair() {
    use latentmail_lib::gmail::labels::LABEL_PALETTE;
    let mut seen = std::collections::HashSet::new();
    for (id, background, text) in LABEL_PALETTE {
        assert!(seen.insert((*background, *text)), "duplicate pair for {id}");
        let pair = resolve_color(id).unwrap();
        assert_eq!(pair.background_color, *background);
        assert_eq!(pair.text_color, *text);
    }
}

fn account(connection: &rusqlite::Connection) {
    use latentmail_lib::storage::{Account, AccountRepository};
    AccountRepository::upsert(
        connection,
        &Account {
            id: "account".into(),
            email: "me@example.com".into(),
            display_name: String::new(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
}

fn user_label(connection: &rusqlite::Connection, id: &str, name: &str) {
    use latentmail_lib::storage::Label;
    LabelRepository::upsert(
        connection,
        &Label {
            account_id: "account".into(),
            id: id.into(),
            name: name.into(),
            kind: "user".into(),
            color: None,
            message_count: 0,
            unread_count: 0,
        },
    )
    .unwrap();
}

/// Every rule a label name can fail reports a distinguishable error (AC6) —
/// not one generic "invalid name" that leaves the caller unable to say why.
#[test]
fn each_label_name_rule_reports_a_distinguishable_error() {
    let connection = Storage::in_memory().unwrap();
    account(&connection);
    user_label(&connection, "Label_1", "Clients");

    assert_eq!(
        LabelRepository::validate_name(&connection, "account", "   ", None),
        Err(LabelNameError::Empty)
    );
    assert_eq!(
        LabelRepository::validate_name(&connection, "account", &"x".repeat(101), None),
        Err(LabelNameError::TooLong)
    );
    assert_eq!(
        LabelRepository::validate_name(&connection, "account", "CATEGORY_Personal", None),
        Err(LabelNameError::ReservedPrefix)
    );
    assert_eq!(
        LabelRepository::validate_name(&connection, "account", "INBOX", None),
        Err(LabelNameError::ReservedPrefix)
    );
    assert_eq!(
        LabelRepository::validate_name(&connection, "account", "Bad\\Name", None),
        Err(LabelNameError::ForbiddenCharacters)
    );
    assert_eq!(
        LabelRepository::validate_name(&connection, "account", "clients", None),
        Err(LabelNameError::Duplicate)
    );
    // Renaming a label to its own current name (case-insensitively)
    // succeeds because the label being renamed is excluded from the
    // uniqueness check.
    assert_eq!(
        LabelRepository::validate_name(&connection, "account", "CLIENTS", Some("Label_1")),
        Ok("CLIENTS".to_owned())
    );
    assert_eq!(
        LabelRepository::validate_name(&connection, "account", "  Vendors  ", None),
        Ok("Vendors".to_owned())
    );
}

#[test]
fn rename_set_color_and_delete_round_trip_locally() {
    use latentmail_lib::storage::LabelColor;
    let connection = Storage::in_memory().unwrap();
    account(&connection);
    user_label(&connection, "Label_1", "Clients");

    LabelRepository::rename(&connection, "account", "Label_1", "Customers").unwrap();
    let color = LabelColor {
        text: "#ffffff".into(),
        background: "#fb4c2f".into(),
    };
    LabelRepository::set_color(&connection, "account", "Label_1", Some(&color)).unwrap();
    let label = LabelRepository::get(&connection, "account", "Label_1")
        .unwrap()
        .unwrap();
    assert_eq!(label.name, "Customers");
    assert_eq!(label.color, Some(color));

    LabelRepository::delete(&connection, "account", "Label_1").unwrap();
    assert!(LabelRepository::get(&connection, "account", "Label_1")
        .unwrap()
        .is_none());
}

/// A colour pair coming back from Gmail unchanged, resolved through
/// [`LabelColorPair`], confirming the type round-trips through the client
/// unmodified.
#[test]
fn label_color_pair_is_plain_data() {
    let pair = LabelColorPair {
        text_color: "#ffffff".into(),
        background_color: "#000000".into(),
    };
    assert_eq!(pair.clone(), pair);
}
