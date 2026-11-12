use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::Env;

struct World {
    env: Env,
    settlement: SettlementManagerClient<'static>,
    token: Address,
    admin: Address,
    funder: Address,
    window: u64,
}

fn world() -> World {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let funder = Address::generate(&env);
    let id = env.register(SettlementManager, ());
    let settlement = SettlementManagerClient::new(&env, &id);
    settlement.initialize(&admin);
    settlement.grant_role(&admin, &Role::Operator, &admin);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    StellarAssetClient::new(&env, &token).mint(&funder, &1_000);

    let window = settlement.open_window(&admin, &token, &0, &1_000);
    World {
        env,
        settlement,
        token,
        admin,
        funder,
        window,
    }
}

#[test]
fn window_pays_every_entry_from_the_pool() {
    let w = world();
    let alice = Address::generate(&w.env);
    let bob = Address::generate(&w.env);

    assert_eq!(
        w.settlement.add_entry(&w.admin, &w.window, &alice, &100),
        100
    );
    assert_eq!(w.settlement.add_entry(&w.admin, &w.window, &bob, &200), 300);
    assert_eq!(w.settlement.get_window(&w.window).entries.len(), 2);

    assert_eq!(
        w.settlement.try_execute(&w.admin, &w.window),
        Err(Ok(Error::InvalidState))
    );

    w.settlement.close_window(&w.admin, &w.window);
    // Unfunded execution must fail rather than partially pay.
    assert_eq!(
        w.settlement.try_execute(&w.admin, &w.window),
        Err(Ok(Error::InsufficientFunds))
    );

    assert_eq!(w.settlement.fund(&w.funder, &w.token, &300), 300);
    w.settlement.execute(&w.admin, &w.window);

    let token = TokenClient::new(&w.env, &w.token);
    assert_eq!(token.balance(&alice), 100);
    assert_eq!(token.balance(&bob), 200);
    assert_eq!(w.settlement.pool(&w.token), 0);
    assert_eq!(
        w.settlement.get_window(&w.window).status,
        WindowStatus::Executed
    );

    // Executing twice cannot pay twice.
    assert_eq!(
        w.settlement.try_execute(&w.admin, &w.window),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn entries_are_immutable_after_close() {
    let w = world();
    w.settlement
        .add_entry(&w.admin, &w.window, &Address::generate(&w.env), &100);
    w.settlement.close_window(&w.admin, &w.window);
    assert_eq!(
        w.settlement
            .try_add_entry(&w.admin, &w.window, &Address::generate(&w.env), &100),
        Err(Ok(Error::WindowClosed))
    );
}

#[test]
fn empty_window_cannot_close() {
    let w = world();
    assert_eq!(
        w.settlement.try_close_window(&w.admin, &w.window),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn operator_role_is_required() {
    let w = world();
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.settlement.try_open_window(&stranger, &w.token, &0, &10),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        w.settlement
            .try_add_entry(&stranger, &w.window, &stranger, &1),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        w.settlement.try_close_window(&stranger, &w.window),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn invalid_period_is_rejected() {
    let w = world();
    assert_eq!(
        w.settlement.try_open_window(&w.admin, &w.token, &100, &100),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn entry_cap_is_enforced() {
    let w = world();
    let payee = Address::generate(&w.env);
    for _ in 0..MAX_ENTRIES {
        w.settlement.add_entry(&w.admin, &w.window, &payee, &1);
    }
    assert_eq!(
        w.settlement.try_add_entry(&w.admin, &w.window, &payee, &1),
        Err(Ok(Error::LimitExceeded))
    );
}

#[test]
fn executed_window_cannot_be_cancelled() {
    let w = world();
    w.settlement
        .add_entry(&w.admin, &w.window, &Address::generate(&w.env), &10);
    w.settlement.close_window(&w.admin, &w.window);
    w.settlement.fund(&w.funder, &w.token, &10);
    w.settlement.execute(&w.admin, &w.window);
    assert_eq!(
        w.settlement.try_cancel(&w.admin, &w.window),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn zero_entry_amount_is_rejected() {
    let w = world();
    assert_eq!(
        w.settlement
            .try_add_entry(&w.admin, &w.window, &Address::generate(&w.env), &0),
        Err(Ok(Error::InvalidInput))
    );
}
