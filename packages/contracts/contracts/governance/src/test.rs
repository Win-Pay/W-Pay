use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{BytesN, Env, String};

struct World {
    env: Env,
    gov: GovernanceClient<'static>,
    admin: Address,
    alice: Address,
    bob: Address,
    payload: BytesN<32>,
}

fn world() -> World {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let id = env.register(Governance, ());
    let gov = GovernanceClient::new(&env, &id);
    gov.initialize(&admin, &1_000, &2);
    gov.add_member(&admin, &alice);
    gov.add_member(&admin, &bob);
    let payload = BytesN::from_array(&env, &[3u8; 32]);
    World {
        env,
        gov,
        admin,
        alice,
        bob,
        payload,
    }
}

fn describe(env: &Env, text: &str) -> String {
    String::from_str(env, text)
}

#[test]
fn proposal_passes_with_quorum_and_majority() {
    let w = world();
    let id = w
        .gov
        .propose(&w.alice, &w.payload, &describe(&w.env, "raise fee cap"));
    assert_eq!(w.gov.proposal_count(), 1);

    w.gov.vote(&w.alice, &id, &true);
    w.gov.vote(&w.bob, &id, &true);
    assert_eq!(w.gov.try_finalize(&id), Err(Ok(Error::InvalidState)));

    w.env.ledger().set_timestamp(2_000);
    assert_eq!(w.gov.finalize(&id), ProposalStatus::Passed);
    w.gov.mark_executed(&w.admin, &id);
    assert_eq!(w.gov.get(&id).status, ProposalStatus::Executed);
}

#[test]
fn quorum_is_required() {
    let w = world();
    let id = w.gov.propose(&w.alice, &w.payload, &describe(&w.env, "x"));
    w.gov.vote(&w.alice, &id, &true);
    w.env.ledger().set_timestamp(2_000);
    assert_eq!(w.gov.finalize(&id), ProposalStatus::Rejected);
}

#[test]
fn majority_must_be_strict() {
    let w = world();
    let id = w.gov.propose(&w.alice, &w.payload, &describe(&w.env, "x"));
    w.gov.add_member(&w.admin, &Address::generate(&w.env));
    let carol = w.gov.members().get(2).unwrap();
    w.gov.vote(&w.alice, &id, &true);
    w.gov.vote(&w.bob, &id, &false);
    w.gov.vote(&carol, &id, &true);
    w.env.ledger().set_timestamp(2_000);
    // 2 for, 1 against, quorum 2: passes.
    assert_eq!(w.gov.finalize(&id), ProposalStatus::Passed);
}

#[test]
fn one_vote_per_member() {
    let w = world();
    let id = w.gov.propose(&w.alice, &w.payload, &describe(&w.env, "x"));
    w.gov.vote(&w.alice, &id, &true);
    assert_eq!(
        w.gov.try_vote(&w.alice, &id, &false),
        Err(Ok(Error::AlreadyVoted))
    );
    assert!(w.gov.has_voted(&id, &w.alice));
}

#[test]
fn non_members_cannot_propose_or_vote() {
    let w = world();
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.gov
            .try_propose(&stranger, &w.payload, &describe(&w.env, "x")),
        Err(Ok(Error::Unauthorized))
    );
    let id = w.gov.propose(&w.alice, &w.payload, &describe(&w.env, "x"));
    assert_eq!(
        w.gov.try_vote(&stranger, &id, &true),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn voting_closes_at_deadline() {
    let w = world();
    let id = w.gov.propose(&w.alice, &w.payload, &describe(&w.env, "x"));
    w.env.ledger().set_timestamp(2_000);
    assert_eq!(
        w.gov.try_vote(&w.bob, &id, &true),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn cancelled_proposal_cannot_be_voted_or_finalized() {
    let w = world();
    let id = w.gov.propose(&w.alice, &w.payload, &describe(&w.env, "x"));
    w.gov.cancel(&w.admin, &id);
    assert_eq!(
        w.gov.try_vote(&w.alice, &id, &true),
        Err(Ok(Error::InvalidState))
    );
    w.env.ledger().set_timestamp(2_000);
    assert_eq!(w.gov.try_finalize(&id), Err(Ok(Error::InvalidState)));
}

#[test]
fn only_passed_proposals_can_be_marked_executed() {
    let w = world();
    let id = w.gov.propose(&w.alice, &w.payload, &describe(&w.env, "x"));
    assert_eq!(
        w.gov.try_mark_executed(&w.admin, &id),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn membership_is_capped_and_unique() {
    let w = world();
    assert_eq!(
        w.gov.try_add_member(&w.admin, &w.alice),
        Err(Ok(Error::AlreadyExists))
    );
    w.gov.remove_member(&w.admin, &w.bob);
    assert!(!w.gov.is_member(&w.bob));
    assert_eq!(w.gov.member_count(), 1);
}

#[test]
fn init_validates_parameters() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(Governance, ());
    let gov = GovernanceClient::new(&env, &id);
    assert_eq!(
        gov.try_initialize(&admin, &0, &1),
        Err(Ok(Error::InvalidInput))
    );
    assert_eq!(
        gov.try_initialize(&admin, &100, &0),
        Err(Ok(Error::InvalidInput))
    );
}
