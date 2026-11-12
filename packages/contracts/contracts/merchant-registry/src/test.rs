use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::String;

fn setup() -> (Env, MerchantRegistryClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(MerchantRegistry, ());
    let client = MerchantRegistryClient::new(&env, &id);
    client.initialize(&admin);
    (env, client, admin)
}

fn name(env: &Env) -> String {
    String::from_str(env, "Blue Harbor Coffee")
}

#[test]
fn register_then_approve_activates() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let settlement = Address::generate(&env);
    let id = client.register(&owner, &settlement, &name(&env), &200);

    let merchant = client.get(&id);
    assert_eq!(merchant.status, MerchantStatus::Pending);
    assert_eq!(merchant.fee_bps, 200);
    assert_eq!(client.merchant_of(&owner), Some(id));
    assert!(!client.is_active(&id));

    client.grant_role(&admin, &Role::Operator, &admin);
    client.approve(&admin, &id);
    assert!(client.is_active(&id));
    assert_eq!(client.active_count(), 1);
}

#[test]
fn duplicate_registration_rejected() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let settlement = Address::generate(&env);
    client.register(&owner, &settlement, &name(&env), &100);
    assert_eq!(
        client.try_register(&owner, &settlement, &name(&env), &100),
        Err(Ok(Error::AlreadyExists))
    );
}

#[test]
fn fee_above_cap_rejected() {
    let (env, client, _admin) = setup();
    assert_eq!(
        client.try_register(
            &Address::generate(&env),
            &Address::generate(&env),
            &name(&env),
            &(MAX_FEE_BPS + 1)
        ),
        Err(Ok(Error::LimitExceeded))
    );
}

#[test]
fn empty_name_rejected() {
    let (env, client, _admin) = setup();
    let empty = String::from_str(&env, "");
    assert_eq!(
        client.try_register(
            &Address::generate(&env),
            &Address::generate(&env),
            &empty,
            &100
        ),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn suspend_and_reactivate() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let id = client.register(&owner, &Address::generate(&env), &name(&env), &100);
    client.grant_role(&admin, &Role::Operator, &admin);
    client.approve(&admin, &id);

    client.suspend(&admin, &id);
    assert_eq!(client.get(&id).status, MerchantStatus::Suspended);
    assert_eq!(client.active_count(), 0);

    client.reactivate(&admin, &id);
    assert!(client.is_active(&id));
}

#[test]
fn invalid_transitions_rejected() {
    let (env, client, admin) = setup();
    let id = client.register(
        &Address::generate(&env),
        &Address::generate(&env),
        &name(&env),
        &100,
    );
    client.grant_role(&admin, &Role::Operator, &admin);

    // Cannot suspend a merchant that was never approved.
    assert_eq!(
        client.try_suspend(&admin, &id),
        Err(Ok(Error::InvalidState))
    );
    // Cannot reactivate an active merchant.
    client.approve(&admin, &id);
    assert_eq!(
        client.try_reactivate(&admin, &id),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn close_is_terminal() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let id = client.register(&owner, &Address::generate(&env), &name(&env), &100);
    client.grant_role(&admin, &Role::Operator, &admin);
    client.approve(&admin, &id);

    client.close(&owner, &id);
    assert_eq!(client.get(&id).status, MerchantStatus::Closed);
    assert_eq!(client.active_count(), 0);
    assert_eq!(client.try_close(&owner, &id), Err(Ok(Error::InvalidState)));
    assert_eq!(
        client.try_update_settlement(&owner, &id, &Address::generate(&env)),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn only_owner_can_change_settlement() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let id = client.register(&owner, &Address::generate(&env), &name(&env), &100);
    let next = Address::generate(&env);
    client.update_settlement(&owner, &id, &next);
    assert_eq!(client.get(&id).settlement, next);

    assert_eq!(
        client.try_update_settlement(&Address::generate(&env), &id, &next),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn operator_role_required_to_approve() {
    let (env, client, admin) = setup();
    let id = client.register(
        &Address::generate(&env),
        &Address::generate(&env),
        &name(&env),
        &100,
    );
    assert_eq!(
        client.try_approve(&admin, &id),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn paused_registry_blocks_registration() {
    let (env, client, admin) = setup();
    client.set_paused(&admin, &true);
    assert!(client.is_paused());
    assert_eq!(
        client.try_register(
            &Address::generate(&env),
            &Address::generate(&env),
            &name(&env),
            &100
        ),
        Err(Ok(Error::Paused))
    );
}
