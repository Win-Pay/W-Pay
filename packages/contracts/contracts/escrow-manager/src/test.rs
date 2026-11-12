use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::Env;

struct World {
    env: Env,
    escrow: EscrowManagerClient<'static>,
    token: Address,
    payer: Address,
    payee: Address,
    arbiter: Address,
    admin: Address,
}

const RELEASE_AT: u64 = 5_000;

fn world() -> World {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let id = env.register(EscrowManager, ());
    let escrow = EscrowManagerClient::new(&env, &id);
    escrow.initialize(&admin);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&payer, &10_000);

    let payee = Address::generate(&env);
    let arbiter = Address::generate(&env);
    World {
        env,
        escrow,
        token,
        payer,
        payee,
        arbiter,
        admin,
    }
}

fn create(w: &World) -> u64 {
    w.escrow.create(
        &w.payer,
        &w.payee,
        &w.arbiter,
        &w.token,
        &4_000,
        &RELEASE_AT,
    )
}

#[test]
fn create_locks_funds() {
    let w = world();
    let id = create(&w);
    let escrow = w.escrow.get(&id);
    assert_eq!(escrow.status, EscrowStatus::Funded);
    assert_eq!(escrow.amount, 4_000);
    assert_eq!(w.escrow.locked(&w.token), 4_000);
    assert_eq!(TokenClient::new(&w.env, &w.token).balance(&w.payer), 6_000);
    assert_eq!(w.escrow.count(), 1);
}

#[test]
fn payer_releases_to_payee() {
    let w = world();
    let id = create(&w);
    w.escrow.release(&w.payer, &id);

    assert_eq!(w.escrow.get(&id).status, EscrowStatus::Released);
    assert_eq!(w.escrow.locked(&w.token), 0);
    assert_eq!(TokenClient::new(&w.env, &w.token).balance(&w.payee), 4_000);
    assert_eq!(
        w.escrow.try_release(&w.payer, &id),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn payee_can_claim_only_after_release_at() {
    let w = world();
    let id = create(&w);
    assert_eq!(
        w.escrow.try_release(&w.payee, &id),
        Err(Ok(Error::Unauthorized))
    );

    w.env.ledger().set_timestamp(RELEASE_AT);
    w.escrow.release(&w.payee, &id);
    assert_eq!(TokenClient::new(&w.env, &w.token).balance(&w.payee), 4_000);
}

#[test]
fn payer_refunds_before_release_only() {
    let w = world();
    let id = create(&w);
    w.escrow.refund(&w.payer, &id);
    assert_eq!(w.escrow.get(&id).status, EscrowStatus::Refunded);
    assert_eq!(TokenClient::new(&w.env, &w.token).balance(&w.payer), 10_000);
    assert_eq!(w.escrow.locked(&w.token), 0);

    // After the release date the payer loses unilateral control.
    let second = create(&w);
    w.env.ledger().set_timestamp(RELEASE_AT + 1);
    assert_eq!(
        w.escrow.try_refund(&w.payer, &second),
        Err(Ok(Error::Unauthorized))
    );
    w.escrow.refund(&w.arbiter, &second);
    assert_eq!(w.escrow.get(&second).status, EscrowStatus::Refunded);
}

#[test]
fn dispute_requires_arbiter_resolution() {
    let w = world();
    let id = create(&w);
    w.escrow.dispute(&w.payee, &id);
    assert_eq!(w.escrow.get(&id).status, EscrowStatus::Disputed);
    assert_eq!(
        w.escrow.try_release(&w.payer, &id),
        Err(Ok(Error::InvalidState))
    );

    // Only the recorded arbiter may resolve.
    assert_eq!(
        w.escrow.try_resolve(&w.payer, &id, &true),
        Err(Ok(Error::Unauthorized))
    );
    w.escrow.resolve(&w.arbiter, &id, &true);
    assert_eq!(w.escrow.get(&id).status, EscrowStatus::Released);
    assert_eq!(TokenClient::new(&w.env, &w.token).balance(&w.payee), 4_000);
}

#[test]
fn outsider_cannot_touch_escrow() {
    let w = world();
    let id = create(&w);
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.escrow.try_release(&stranger, &id),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        w.escrow.try_dispute(&stranger, &id),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        w.escrow.try_refund(&stranger, &id),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn duplicate_parties_rejected() {
    let w = world();
    let payer = Address::generate(&w.env);
    assert_eq!(
        w.escrow
            .try_create(&payer, &payer, &w.arbiter, &w.token, &10, &RELEASE_AT),
        Err(Ok(Error::InvalidInput))
    );
    assert_eq!(
        w.escrow
            .try_create(&payer, &w.payee, &w.payee, &w.token, &10, &RELEASE_AT),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn zero_amount_rejected() {
    let w = world();
    assert_eq!(
        w.escrow
            .try_create(&w.payer, &w.payee, &w.arbiter, &w.token, &0, &RELEASE_AT),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn pause_blocks_new_escrows() {
    let w = world();
    w.escrow.grant_role(&w.admin, &Role::Admin, &w.admin);
    w.escrow.set_paused(&w.admin, &true);
    assert_eq!(
        w.escrow
            .try_create(&w.payer, &w.payee, &w.arbiter, &w.token, &100, &RELEASE_AT),
        Err(Ok(Error::Paused))
    );
}
