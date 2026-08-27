use latentmail_lib::ai::fusion::{fuse, select, Selected, FUSION_K};

fn passage(message_seq: i64, chunk_index: i64, similarity: f64) -> Selected {
    Selected {
        message_seq,
        chunk_index,
        similarity,
    }
}

#[test]
fn a_message_returned_by_two_arms_outranks_a_message_returned_by_one() {
    let vector = vec![10, 20, 30];
    let lexical = vec![30, 40];
    assert_eq!(fuse(&[vector, lexical]), vec![30, 10, 20, 40]);
}

#[test]
fn the_reciprocal_rank_contribution_is_one_over_k_plus_rank() {
    assert!((FUSION_K - 60.0).abs() < f64::EPSILON);
    let single = fuse(&[vec![7, 8, 9]]);
    assert_eq!(single, vec![7, 8, 9]);
    let reversed = fuse(&[vec![9, 8, 7]]);
    assert_eq!(reversed, vec![9, 8, 7]);
}

#[test]
fn identical_inputs_always_produce_identical_output_including_under_ties() {
    let arms = vec![vec![5, 3, 1], vec![1, 3, 5], vec![9, 3]];
    let first = fuse(&arms);
    for _ in 0..20 {
        assert_eq!(fuse(&arms), first);
    }
    assert_eq!(fuse(&[vec![4, 2], vec![2, 4]]), vec![2, 4]);
    assert_eq!(fuse(&[vec![2, 4], vec![4, 2]]), vec![2, 4]);
    assert!(fuse(&[]).is_empty());
    assert!(fuse(&[Vec::new()]).is_empty());
}

#[test]
fn each_surviving_message_contributes_its_best_scoring_passage() {
    let scored = vec![passage(1, 0, 0.6), passage(1, 4, 0.91), passage(2, 2, 0.72)];
    assert_eq!(
        select(&[1, 2], &scored, 15),
        vec![passage(1, 4, 0.91), passage(2, 2, 0.72)]
    );
}

#[test]
fn a_message_with_no_passage_score_falls_back_to_its_first_chunk() {
    let scored = vec![passage(1, 3, 0.8)];
    assert_eq!(
        select(&[7, 1], &scored, 15),
        vec![passage(7, 0, 0.0), passage(1, 3, 0.8)]
    );
}

#[test]
fn selection_caps_the_passage_count_and_keeps_the_fused_order() {
    let order: Vec<i64> = (1..=30).collect();
    let selected = select(&order, &[], 15);
    assert_eq!(selected.len(), 15);
    assert_eq!(selected[0].message_seq, 1);
    assert_eq!(selected[14].message_seq, 15);
    assert!(select(&[], &[], 15).is_empty());
}
