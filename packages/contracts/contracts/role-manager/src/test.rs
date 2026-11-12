use super::*;
use soroban_sdk::testutils::Address as _;

fn setup() -> (Env, RoleManagerClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(RoleManager, ());
    let client = RoleManagerClient::new(&env, &id);
    client.initialize(&admin);
    (env, client, admin)
}

#[test]
fn initialize_sets_only_admin() {
    let (env, client, admin) = setup();
    assert!(client.is_admin(&admin));
    assert_eq!(client.role_count(&Role::Admin), 1);

    let operator = Address::generate(&env);
    assert!(!client.has_role(&Role::Operator, &operator));
}

#[test]
fn double_initialize_is_rejected() {
    let (env, client, admin) = setup();
    let result = client.try_initialize(&admin);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn grant_and_revoke_round_trip() {
    let (env, client, admin) = setup();
    let operator = Address::generate(&env);

    client.grant_role(&admin, &Role::Operator, &operator);
    assert!(client.has_role(&Role::Operator, &operator));
    assert_eq!(client.holders(&Role::Operator).len(), 1);

    client.revoke_role(&admin, &Role::Operator, &operator);
    assert!(!client.has_role(&Role::Operator, &operator));
    assert_eq!(client.holders(&Role::Operator).len(), 0);
}

#[test]
fn non_admin_cannot_grant() {
    let (env, client, _admin) = setup();
    let stranger = Address::generate(&env);
    let victim = Address::generate(&env);

    let result = client.try_grant_role(&stranger, &Role::Admin, &victim);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert!(!client.is_admin(&victim));
}

#[test]
fn grant_is_idempotent_for_holders() {
    let (env, client, admin) = setup();
    let operator = Address::generate(&env);
    client.grant_role(&admin, &Role::Operator, &operator);
    client.grant_role(&admin, &Role::Operator, &operator);
    assert_eq!(client.role_count(&Role::Operator), 1);
    assert_eq!(client.holders(&Role::Operator).len(), 1);
}

#[test]
fn transfer_admin_removes_old_admin() {
    let (env, client, admin) = setup();
    let next = Address::generate(&env);
    client.transfer_admin(&admin, &next);

    assert!(client.is_admin(&next));
    assert!(!client.is_admin(&admin));
    assert_eq!(client.role_count(&Role::Admin), 1);
}

#[test]
fn self_revoke_of_admin_is_rejected() {
    let (_env, client, admin) = setup();
    let result = client.try_revoke_role(&admin, &Role::Admin, &admin);
    assert_eq!(result, Err(Ok(Error::InvalidInput)));
    assert!(client.is_admin(&admin));
}

#[test]
fn holder_cap_is_enforced() {
    let (env, client, admin) = setup();
    for _ in 0..MAX_HOLDERS_PER_ROLE {
        client.grant_role(&admin, &Role::Auditor, &Address::generate(&env));
    }
    let result = client.try_grant_role(&admin, &Role::Auditor, &Address::generate(&env));
    assert_eq!(result, Err(Ok(Error::LimitExceeded)));
}
