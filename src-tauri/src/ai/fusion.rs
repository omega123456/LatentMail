use std::cmp::Ordering;

pub const FUSION_K: f64 = 60.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Selected {
    pub message_seq: i64,
    pub chunk_index: i64,
    pub similarity: f64,
}

pub fn fuse(arms: &[Vec<i64>]) -> Vec<i64> {
    let mut scores: Vec<(i64, f64)> = Vec::new();
    for arm in arms {
        for (rank, message_seq) in arm.iter().enumerate() {
            let contribution = 1.0 / (FUSION_K + rank as f64 + 1.0);
            match scores.iter_mut().find(|(seq, _)| seq == message_seq) {
                Some(entry) => entry.1 += contribution,
                None => scores.push((*message_seq, contribution)),
            }
        }
    }
    scores.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(Ordering::Equal)
            .then(left.0.cmp(&right.0))
    });
    scores
        .into_iter()
        .map(|(message_seq, _)| message_seq)
        .collect()
}

pub fn select(order: &[i64], scored: &[Selected], limit: usize) -> Vec<Selected> {
    order
        .iter()
        .take(limit)
        .map(|message_seq| {
            scored
                .iter()
                .filter(|entry| entry.message_seq == *message_seq)
                .max_by(|left, right| {
                    left.similarity
                        .partial_cmp(&right.similarity)
                        .unwrap_or(Ordering::Equal)
                })
                .copied()
                .unwrap_or(Selected {
                    message_seq: *message_seq,
                    chunk_index: 0,
                    similarity: 0.0,
                })
        })
        .collect()
}
