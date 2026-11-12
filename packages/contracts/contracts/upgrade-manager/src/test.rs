use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{BytesN, Env};

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn setup(delay: u64) -> (Env, UpgradeManagerClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let id = env.register(UpgradeManager, ());
    let client = UpgradeManagerClient::new(&env, &id);
    client.initialize(&admin, &delay);
    (env, client, admin)
}

#[test]
fn delay_bounds_are_enforced() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(UpgradeManager, ());
    let client = UpgradeManagerClient::new(&env, &id);
    assert_eq!(
        client.try_initialize(&admin, &(MIN_DELAY_SECS - 1)),
        Err(Ok(Error::InvalidInput))
    );
    assert_eq!(
        client.try_initialize(&admin, &(MAX_DELAY_SECS + 1)),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn execute_waits_for_timelock() {
    let (env, client, admin) = setup(MIN_DELAY_SECS);
    let wasm = hash(&env, 7);
    let executable_at = client.propose(&admin, &wasm);
    assert_eq!(executable_at, 1_000 + MIN_DELAY_SECS);
    assert!(!client.is_ready());

    assert_eq!(
        client.try_execute(&admin),
        Err(Ok(Error::TimelockNotElapsed))
    );

    env.ledger().set_timestamp(executable_at);
    assert!(client.is_ready());
    assert_eq!(client.execute(&admin), wasm);
    assert_eq!(client.pending(), None);
    assert_eq!(client.try_execute(&admin), Err(Ok(Error::NotFound)));
}

#[test]
fn cancel_clears_proposal() {
    let (env, client, admin) = setup(MIN_DELAY_SECS);
    client.propose(&admin, &hash(&env, 1));
    client.cancel(&admin);
    assert_eq!(client.pending(), None);
    assert_eq!(client.try_cancel(&admin), Err(Ok(Error::NotFound)));
}

#[test]
fn re_propose_restarts_the_timer() {
    let (env, client, admin) = setup(MIN_DELAY_SECS);
    client.propose(&admin, &hash(&env, 1));
    env.ledger().set_timestamp(1_000 + MIN_DELAY_SECS - 1);
    let new_at = client.propose(&admin, &hash(&env, 2));
    assert_eq!(new_at, 1_000 + MIN_DELAY_SECS - 1 + MIN_DELAY_SECS);

    env.ledger().set_timestamp(1_000 + MIN_DELAY_SECS);
    assert_eq!(
        client.try_execute(&admin),
        Err(Ok(Error::TimelockNotElapsed))
    );
}

#[test]
fn only_admin_can_propose_or_execute() {
    let (env, client, _admin) = setup(MIN_DELAY_SECS);
    let stranger = Address::generate(&env);
    assert_eq!(
        client.try_propose(&stranger, &hash(&env, 1)),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(client.try_execute(&stranger), Err(Ok(Error::Unauthorized)));
}

#[test]
fn proposed_hash_is_visible() {
    let (env, client, admin) = setup(MIN_DELAY_SECS);
    let wasm = hash(&env, 9);
    client.propose(&admin, &wasm);
    let pending = client.pending().unwrap();
    assert_eq!(pending.wasm_hash, wasm);
    assert_eq!(pending.proposed_at, 1_000);
    assert_eq!(pending.executable_at, 1_000 + MIN_DELAY_SECS);
}
