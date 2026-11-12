use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::Env;

struct World {
    env: Env,
    vault: TreasuryVaultClient<'static>,
    token: Address,
    admin: Address,
    funder: Address,
    recipient: Address,
}

fn world() -> World {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let funder = Address::generate(&env);
    let id = env.register(TreasuryVault, ());
    let vault = TreasuryVaultClient::new(&env, &id);
    vault.initialize(&admin);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    StellarAssetClient::new(&env, &token).mint(&funder, &10_000);

    let recipient = Address::generate(&env);
    World {
        env,
        vault,
        token,
        admin,
        funder,
        recipient,
    }
}

#[test]
fn deposit_and_small_withdrawal() {
    let w = world();
    assert_eq!(w.vault.deposit(&w.funder, &w.token, &1_000), 1_000);
    assert_eq!(w.vault.balance(&w.token), 1_000);

    w.vault.set_threshold(&w.admin, &w.token, &500);
    w.vault.withdraw(&w.admin, &w.token, &w.recipient, &400);
    assert_eq!(w.vault.balance(&w.token), 600);
    assert_eq!(
        TokenClient::new(&w.env, &w.token).balance(&w.recipient),
        400
    );
}

#[test]
fn large_withdrawal_requires_timelock() {
    let w = world();
    w.vault.deposit(&w.funder, &w.token, &1_000);
    w.vault.set_threshold(&w.admin, &w.token, &500);
    assert_eq!(
        w.vault.try_withdraw(&w.admin, &w.token, &w.recipient, &501),
        Err(Ok(Error::TimelockActive))
    );

    let id = w
        .vault
        .schedule_withdrawal(&w.admin, &w.token, &w.recipient, &1_000);
    assert_eq!(
        w.vault.try_execute_withdrawal(&w.admin, &id),
        Err(Ok(Error::TimelockNotElapsed))
    );

    w.env.ledger().set_timestamp(1_000 + TIMELOCK_SECS);
    w.vault.execute_withdrawal(&w.admin, &id);
    assert_eq!(w.vault.balance(&w.token), 0);
    assert_eq!(
        TokenClient::new(&w.env, &w.token).balance(&w.recipient),
        1_000
    );
    assert_eq!(
        w.vault.get_withdrawal(&id).status,
        WithdrawalStatus::Executed
    );
    assert_eq!(
        w.vault.try_execute_withdrawal(&w.admin, &id),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn cancelled_withdrawal_cannot_execute() {
    let w = world();
    w.vault.deposit(&w.funder, &w.token, &1_000);
    let id = w
        .vault
        .schedule_withdrawal(&w.admin, &w.token, &w.recipient, &500);
    w.vault.cancel_withdrawal(&w.admin, &id);
    w.env.ledger().set_timestamp(1_000 + TIMELOCK_SECS);
    assert_eq!(
        w.vault.try_execute_withdrawal(&w.admin, &id),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn cannot_withdraw_more_than_balance() {
    let w = world();
    w.vault.deposit(&w.funder, &w.token, &100);
    assert_eq!(
        w.vault
            .try_schedule_withdrawal(&w.admin, &w.token, &w.recipient, &101),
        Err(Ok(Error::InsufficientFunds))
    );
}

#[test]
fn non_admin_cannot_withdraw() {
    let w = world();
    w.vault.deposit(&w.funder, &w.token, &100);
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.vault.try_withdraw(&stranger, &w.token, &w.recipient, &1),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        w.vault
            .try_schedule_withdrawal(&stranger, &w.token, &w.recipient, &1),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn pause_blocks_outflows_but_not_deposits() {
    let w = world();
    w.vault.set_threshold(&w.admin, &w.token, &1_000);
    w.vault.deposit(&w.funder, &w.token, &100);
    w.vault.set_paused(&w.admin, &true);
    assert_eq!(
        w.vault.try_withdraw(&w.admin, &w.token, &w.recipient, &10),
        Err(Ok(Error::Paused))
    );
    // Deposits still work during an incident.
    assert_eq!(w.vault.deposit(&w.funder, &w.token, &100), 200);
}

#[test]
fn negative_threshold_rejected() {
    let w = world();
    assert_eq!(
        w.vault.try_set_threshold(&w.admin, &w.token, &-1),
        Err(Ok(Error::InvalidInput))
    );
}
