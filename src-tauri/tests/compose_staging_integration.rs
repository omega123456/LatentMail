use std::{collections::HashSet, fs};

use latentmail_lib::{compose::staging::Staging, gmail::GmailClient};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

#[test]
fn snapshots_survive_source_removal_and_completed_snapshots_can_be_released() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("report.txt");
    fs::write(&source, b"attachment").unwrap();
    let staging = Staging::new(directory.path().join("staged"));
    let part = staging
        .stage_path(
            "account",
            "draft",
            &source,
            "part",
            "text/plain".into(),
            None,
        )
        .unwrap();
    assert_eq!(part.size, b"attachment".len() as u64);
    fs::remove_file(source).unwrap();

    let snapshot = staging.snapshot("operation", &[part]).unwrap();
    assert_eq!(snapshot.parts[0].read().unwrap().bytes, b"attachment");
    assert_eq!(staging.snapshot_manifest("operation").unwrap(), snapshot);
    let live = HashSet::from(["operation".to_owned()]);
    staging.cleanup_orphan_snapshots(&live).unwrap();
    assert!(snapshot.parts[0].path.exists());
    staging.release_snapshot("operation").unwrap();
    assert!(!directory
        .path()
        .join("staged/operations/operation")
        .exists());
    assert!(!snapshot.parts[0].path.exists());
    assert_eq!(
        staging
            .stage_bytes(
                "account",
                "draft",
                &latentmail_lib::compose::staging::StagedPart {
                    id: "second".into(),
                    filename: "inline.png".into(),
                    mime_type: "image/png".into(),
                    path: directory.path().join("unused"),
                    content_id: Some("cid".into()),
                    size: 0,
                },
                b"image"
            )
            .unwrap()
            .read()
            .unwrap()
            .bytes,
        b"image"
    );
}

#[tokio::test]
async fn gmail_hydrated_attachments_produce_the_same_staged_descriptor_shape_as_a_path() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/messages/m1/attachments/a1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "size": 5,
            "data": base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                b"bytes"
            ),
        })))
        .mount(&server)
        .await;
    let client = GmailClient::with_base_url("token", format!("{}/gmail/v1", server.uri()));

    let directory = tempfile::tempdir().unwrap();
    let staging = Staging::new(directory.path().join("staged"));
    let hydrated = staging
        .stage_attachment(
            &client,
            "account",
            "draft",
            latentmail_lib::compose::staging::GmailAttachmentSource {
                message_id: "m1",
                attachment_id: "a1",
            },
            latentmail_lib::compose::staging::NewStagedPart {
                id: "hydrated-1".into(),
                filename: "photo.png".into(),
                mime_type: "image/png".into(),
                content_id: Some("cid:1".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(hydrated.read().unwrap().bytes, b"bytes");
    assert_eq!(hydrated.filename, "photo.png");
    assert_eq!(hydrated.content_id.as_deref(), Some("cid:1"));

    let source = directory.path().join("source.png");
    fs::write(&source, b"bytes").unwrap();
    let path_staged = staging
        .stage_path(
            "account",
            "draft",
            &source,
            "path-1",
            "image/png".into(),
            None,
        )
        .unwrap();
    assert_eq!(
        path_staged.read().unwrap().bytes,
        hydrated.read().unwrap().bytes
    );
}

#[test]
fn removing_one_staged_part_never_touches_its_siblings_or_a_live_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("a.txt");
    fs::write(&source, b"a").unwrap();
    let staging = Staging::new(directory.path().join("staged"));
    let a = staging
        .stage_path("account", "draft", &source, "a", "text/plain".into(), None)
        .unwrap();
    let b = staging
        .stage_bytes(
            "account",
            "draft",
            &latentmail_lib::compose::staging::StagedPart {
                id: "b".into(),
                filename: "b.txt".into(),
                mime_type: "text/plain".into(),
                path: directory.path().join("unused"),
                content_id: None,
                size: 0,
            },
            b"b",
        )
        .unwrap();
    let snapshot = staging.snapshot("op", &[a.clone(), b.clone()]).unwrap();

    staging.remove_part("account", "draft", "a").unwrap();
    assert!(!a.path.exists());
    assert!(b.path.exists());
    assert!(snapshot.parts[0].path.exists(), "snapshot is immutable");
    assert!(snapshot.parts[1].path.exists());
}

#[test]
fn owners_can_move_and_release_without_affecting_unrelated_snapshots() {
    let directory = tempfile::tempdir().unwrap();
    let staging = Staging::new(directory.path().join("staged"));
    let part = staging
        .stage_bytes(
            "account",
            "session",
            &latentmail_lib::compose::staging::StagedPart {
                id: "part".into(),
                filename: "note.txt".into(),
                mime_type: "text/plain".into(),
                path: directory.path().join("unused"),
                content_id: None,
                size: 0,
            },
            b"note",
        )
        .unwrap();

    staging
        .move_owner("account", "nonexistent-owner", "draft")
        .unwrap();
    staging.move_owner("account", "session", "draft").unwrap();
    staging.move_owner("account", "draft", "draft").unwrap();
    let moved = staging
        .part(
            "account",
            &["draft"],
            "part",
            "note.txt".into(),
            "text/plain".into(),
            None,
        )
        .unwrap();
    assert_eq!(moved.read().unwrap().bytes, b"note");
    assert!(!part.path.exists(), "the session owner was renamed");

    let snapshot = staging.snapshot("live", &[moved]).unwrap();
    staging.cleanup_orphan_snapshots(&HashSet::new()).unwrap();
    assert!(!snapshot.parts[0].path.exists());
    staging.release_owner("account", "draft").unwrap();
    staging.release_owner("account", "missing").unwrap();
    assert!(staging
        .part(
            "account",
            &["draft"],
            "part",
            "note.txt".into(),
            "text/plain".into(),
            None,
        )
        .is_err());
}

#[test]
fn a_part_resolves_under_either_owner_across_the_ownership_transfer() {
    let directory = tempfile::tempdir().unwrap();
    let staging = Staging::new(directory.path().join("staged"));
    let descriptor = |id: &str| latentmail_lib::compose::staging::StagedPart {
        id: id.into(),
        filename: "note.txt".into(),
        mime_type: "text/plain".into(),
        path: directory.path().join("unused"),
        content_id: None,
        size: 0,
    };
    staging
        .stage_bytes("account", "session", &descriptor("early"), b"early")
        .unwrap();
    staging
        .stage_bytes("account", "draft", &descriptor("late"), b"late")
        .unwrap();

    let owners = ["draft", "session"];
    let early = staging
        .part(
            "account",
            &owners,
            "early",
            "note.txt".into(),
            "text/plain".into(),
            None,
        )
        .unwrap();
    assert_eq!(early.read().unwrap().bytes, b"early");

    staging.move_owner("account", "session", "draft").unwrap();
    for (id, bytes) in [("early", &b"early"[..]), ("late", &b"late"[..])] {
        let part = staging
            .part(
                "account",
                &owners,
                id,
                "note.txt".into(),
                "text/plain".into(),
                None,
            )
            .unwrap();
        assert_eq!(part.read().unwrap().bytes, bytes, "{id} survived the merge");
    }
    assert!(
        !early.path.exists(),
        "the session owner is gone once merged"
    );
    assert!(staging
        .part(
            "account",
            &[],
            "early",
            "note.txt".into(),
            "text/plain".into(),
            None
        )
        .is_err());
}

#[test]
fn recovery_cleanup_tolerates_an_absent_operations_directory_and_missing_releases() {
    let directory = tempfile::tempdir().unwrap();
    let staging = Staging::new(directory.path().join("staged"));

    staging.cleanup_orphan_snapshots(&HashSet::new()).unwrap();
    staging.release_snapshot("already-gone").unwrap();
    staging.release_owner("account", "already-gone").unwrap();
}

#[test]
fn snapshot_fails_when_a_staged_part_vanishes_before_it_is_copied() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("report.txt");
    fs::write(&source, b"attachment").unwrap();
    let staging = Staging::new(directory.path().join("staged"));
    let part = staging
        .stage_path(
            "account",
            "draft",
            &source,
            "part",
            "text/plain".into(),
            None,
        )
        .unwrap();
    fs::remove_file(&part.path).unwrap();

    assert!(staging.snapshot("operation", &[part]).is_err());
}

#[test]
fn staging_reports_missing_sources_and_unknown_parts() {
    let directory = tempfile::tempdir().unwrap();
    let staging = Staging::new(directory.path().join("staged"));

    assert!(staging
        .stage_path(
            "account",
            "draft",
            &directory.path().join("missing.txt"),
            "part",
            "text/plain".into(),
            None,
        )
        .is_err());
    assert!(staging
        .part(
            "account",
            &["draft"],
            "missing",
            "missing.txt".into(),
            "text/plain".into(),
            None,
        )
        .is_err());
}
