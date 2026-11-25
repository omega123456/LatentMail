use latentmail_lib::compose::staging::{
    OwnerScope, OwnerTransfer, PartLookup, StageAttachmentRequest, StageBytesRequest,
    StagePathRequest,
};
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
        .stage_path(StagePathRequest {
            scope: OwnerScope {
                account_id: "account",
                owner: "draft",
            },
            source: &source,
            id: "part",
            mime_type: "text/plain".into(),
            content_id: None,
        })
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
            .stage_bytes(StageBytesRequest {
                scope: OwnerScope {
                    account_id: "account",
                    owner: "draft"
                },
                descriptor: &latentmail_lib::compose::staging::StagedPart {
                    id: "second".into(),
                    filename: "inline.png".into(),
                    mime_type: "image/png".into(),
                    path: directory.path().join("unused"),
                    content_id: Some("cid".into()),
                    size: 0,
                },
                bytes: b"image"
            })
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
            StageAttachmentRequest {
                scope: OwnerScope {
                    account_id: "account",
                    owner: "draft",
                },
                source: latentmail_lib::compose::staging::GmailAttachmentSource {
                    message_id: "m1",
                    attachment_id: "a1",
                },
                descriptor: latentmail_lib::compose::staging::NewStagedPart {
                    id: "hydrated-1".into(),
                    filename: "photo.png".into(),
                    mime_type: "image/png".into(),
                    content_id: Some("cid:1".into()),
                },
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
        .stage_path(StagePathRequest {
            scope: OwnerScope {
                account_id: "account",
                owner: "draft",
            },
            source: &source,
            id: "path-1",
            mime_type: "image/png".into(),
            content_id: None,
        })
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
    let staged_path = staging
        .stage_path(StagePathRequest {
            scope: OwnerScope {
                account_id: "account",
                owner: "draft",
            },
            source: &source,
            id: "a",
            mime_type: "text/plain".into(),
            content_id: None,
        })
        .unwrap();
    let staged_bytes = staging
        .stage_bytes(StageBytesRequest {
            scope: OwnerScope {
                account_id: "account",
                owner: "draft",
            },
            descriptor: &latentmail_lib::compose::staging::StagedPart {
                id: "b".into(),
                filename: "b.txt".into(),
                mime_type: "text/plain".into(),
                path: directory.path().join("unused"),
                content_id: None,
                size: 0,
            },
            bytes: b"b",
        })
        .unwrap();
    let snapshot = staging
        .snapshot("op", &[staged_path.clone(), staged_bytes.clone()])
        .unwrap();

    staging
        .remove_part(
            OwnerScope {
                account_id: "account",
                owner: "draft",
            },
            "a",
        )
        .unwrap();
    assert!(!staged_path.path.exists());
    assert!(staged_bytes.path.exists());
    assert!(snapshot.parts[0].path.exists(), "snapshot is immutable");
    assert!(snapshot.parts[1].path.exists());
}

fn note_descriptor(
    directory: &std::path::Path,
    id: &str,
) -> latentmail_lib::compose::staging::StagedPart {
    latentmail_lib::compose::staging::StagedPart {
        id: id.into(),
        filename: "note.txt".into(),
        mime_type: "text/plain".into(),
        path: directory.join("unused"),
        content_id: None,
        size: 0,
    }
}

fn note_lookup<'a>(owners: &'a [&'a str], id: &'a str) -> PartLookup<'a> {
    PartLookup {
        account_id: "account",
        owners: owners,
        id: id,
        filename: "note.txt".into(),
        mime_type: "text/plain".into(),
        content_id: None,
    }
}

#[test]
fn owners_can_move_and_release_without_affecting_unrelated_snapshots() {
    let directory = tempfile::tempdir().unwrap();
    let staging = Staging::new(directory.path().join("staged"));
    let part = staging
        .stage_bytes(StageBytesRequest {
            scope: OwnerScope {
                account_id: "account",
                owner: "session",
            },
            descriptor: &note_descriptor(directory.path(), "part"),
            bytes: b"note",
        })
        .unwrap();

    for (from, to) in [
        ("nonexistent-owner", "draft"),
        ("session", "draft"),
        ("draft", "draft"),
    ] {
        staging
            .move_owner(OwnerTransfer {
                account_id: "account",
                from: from,
                to: to,
            })
            .unwrap();
    }
    let moved = staging.part(note_lookup(&["draft"], "part")).unwrap();
    assert_eq!(moved.read().unwrap().bytes, b"note");
    assert!(!part.path.exists(), "the session owner was renamed");

    let snapshot = staging.snapshot("live", &[moved]).unwrap();
    staging.cleanup_orphan_snapshots(&HashSet::new()).unwrap();
    assert!(!snapshot.parts[0].path.exists());
    staging.release_owner("account", "draft").unwrap();
    staging.release_owner("account", "missing").unwrap();
    assert!(staging.part(note_lookup(&["draft"], "part")).is_err());
}

#[test]
fn a_part_resolves_under_either_owner_across_the_ownership_transfer() {
    let directory = tempfile::tempdir().unwrap();
    let staging = Staging::new(directory.path().join("staged"));
    staging
        .stage_bytes(StageBytesRequest {
            scope: OwnerScope {
                account_id: "account",
                owner: "session",
            },
            descriptor: &note_descriptor(directory.path(), "early"),
            bytes: b"early",
        })
        .unwrap();
    staging
        .stage_bytes(StageBytesRequest {
            scope: OwnerScope {
                account_id: "account",
                owner: "draft",
            },
            descriptor: &note_descriptor(directory.path(), "late"),
            bytes: b"late",
        })
        .unwrap();

    let owners = ["draft", "session"];
    let early = staging.part(note_lookup(&owners, "early")).unwrap();
    assert_eq!(early.read().unwrap().bytes, b"early");

    staging
        .move_owner(OwnerTransfer {
            account_id: "account",
            from: "session",
            to: "draft",
        })
        .unwrap();
    for (id, bytes) in [("early", &b"early"[..]), ("late", &b"late"[..])] {
        let part = staging.part(note_lookup(&owners, id)).unwrap();
        assert_eq!(part.read().unwrap().bytes, bytes, "{id} survived the merge");
    }
    assert!(
        !early.path.exists(),
        "the session owner is gone once merged"
    );
    assert!(staging.part(note_lookup(&[], "early")).is_err());
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
        .stage_path(StagePathRequest {
            scope: OwnerScope {
                account_id: "account",
                owner: "draft",
            },
            source: &source,
            id: "part",
            mime_type: "text/plain".into(),
            content_id: None,
        })
        .unwrap();
    fs::remove_file(&part.path).unwrap();

    assert!(staging.snapshot("operation", &[part]).is_err());
}

#[test]
fn staging_reports_missing_sources_and_unknown_parts() {
    let directory = tempfile::tempdir().unwrap();
    let staging = Staging::new(directory.path().join("staged"));

    assert!(staging
        .stage_path(StagePathRequest {
            scope: OwnerScope {
                account_id: "account",
                owner: "draft"
            },
            source: &directory.path().join("missing.txt"),
            id: "part",
            mime_type: "text/plain".into(),
            content_id: None
        })
        .is_err());
    assert!(staging
        .part(PartLookup {
            account_id: "account",
            owners: &["draft"],
            id: "missing",
            filename: "missing.txt".into(),
            mime_type: "text/plain".into(),
            content_id: None
        })
        .is_err());
}

#[tokio::test]
async fn staging_a_gmail_attachment_surfaces_a_refused_download() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/messages/m1/attachments/a1"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&server)
        .await;
    let client = GmailClient::with_base_url("token", format!("{}/gmail/v1", server.uri()));
    let directory = tempfile::tempdir().unwrap();
    let staging = Staging::new(directory.path().join("staged"));

    assert!(staging
        .stage_attachment(
            &client,
            StageAttachmentRequest {
                scope: OwnerScope {
                    account_id: "account",
                    owner: "draft"
                },
                source: latentmail_lib::compose::staging::GmailAttachmentSource {
                    message_id: "m1",
                    attachment_id: "a1",
                },
                descriptor: latentmail_lib::compose::staging::NewStagedPart {
                    id: "hydrated-1".into(),
                    filename: "photo.png".into(),
                    mime_type: "image/png".into(),
                    content_id: None,
                }
            }
        )
        .await
        .is_err());
}
