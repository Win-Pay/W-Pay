use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{symbol_short, BytesN, Env};

struct World {
    env: Env,
    nft: ImpactNFTClient<'static>,
    admin: Address,
    alice: Address,
    meta: BytesN<32>,
}

fn world() -> World {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(ImpactNFT, ());
    let nft = ImpactNFTClient::new(&env, &id);
    nft.initialize(&admin);
    let alice = Address::generate(&env);
    let meta = BytesN::from_array(&env, &[1u8; 32]);
    World {
        env,
        nft,
        admin,
        alice,
        meta,
    }
}

#[test]
fn mint_records_soulbound_badge() {
    let w = world();
    let id = w
        .nft
        .mint(&w.admin, &w.alice, &symbol_short!("FIRST"), &w.meta);
    assert_eq!(id, 1);
    assert_eq!(w.nft.owner_of(&id), w.alice);
    assert_eq!(w.nft.balance_of(&w.alice), 1);
    assert!(w.nft.has_kind(&w.alice, &symbol_short!("FIRST")));
    assert_eq!(w.nft.tokens_of(&w.alice).get(0).unwrap(), 1);
    assert_eq!(w.nft.total_minted(), 1);
    assert_eq!(w.nft.kind_count(&symbol_short!("FIRST")), 1);

    let badge = w.nft.get(&id);
    assert_eq!(badge.metadata, w.meta);
    assert_eq!(badge.kind, symbol_short!("FIRST"));
}

#[test]
fn duplicate_kind_rejected() {
    let w = world();
    w.nft
        .mint(&w.admin, &w.alice, &symbol_short!("FIRST"), &w.meta);
    assert_eq!(
        w.nft
            .try_mint(&w.admin, &w.alice, &symbol_short!("FIRST"), &w.meta),
        Err(Ok(Error::AlreadyExists))
    );
    // A different kind is allowed.
    w.nft
        .mint(&w.admin, &w.alice, &symbol_short!("SECOND"), &w.meta);
    assert_eq!(w.nft.balance_of(&w.alice), 2);
}

#[test]
fn only_admin_can_mint_or_revoke() {
    let w = world();
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.nft
            .try_mint(&stranger, &w.alice, &symbol_short!("FIRST"), &w.meta),
        Err(Ok(Error::Unauthorized))
    );
    let id = w
        .nft
        .mint(&w.admin, &w.alice, &symbol_short!("FIRST"), &w.meta);
    assert_eq!(
        w.nft.try_revoke(&stranger, &id),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn revoke_retires_badge() {
    let w = world();
    let id = w
        .nft
        .mint(&w.admin, &w.alice, &symbol_short!("FIRST"), &w.meta);
    w.nft.revoke(&w.admin, &id);
    assert_eq!(w.nft.try_owner_of(&id), Err(Ok(Error::NotFound)));
    assert_eq!(w.nft.balance_of(&w.alice), 0);
    assert!(!w.nft.has_kind(&w.alice, &symbol_short!("FIRST")));
    assert_eq!(w.nft.total_minted(), 0);
    assert_eq!(w.nft.kind_count(&symbol_short!("FIRST")), 0);
    assert_eq!(w.nft.try_revoke(&w.admin, &id), Err(Ok(Error::NotFound)));
}

#[test]
fn holdings_are_capped() {
    let w = world();
    for i in 0..MAX_PER_OWNER {
        let buf = kind_name(i);
        let kind = Symbol::new(&w.env, core::str::from_utf8(&buf).unwrap());
        w.nft.mint(&w.admin, &w.alice, &kind, &w.meta);
    }
    let buf = kind_name(MAX_PER_OWNER);
    let over = Symbol::new(&w.env, core::str::from_utf8(&buf).unwrap());
    assert_eq!(
        w.nft.try_mint(&w.admin, &w.alice, &over, &w.meta),
        Err(Ok(Error::LimitExceeded))
    );
}

/// Builds "K00".."K50" without needing an allocator in a `no_std` test.
fn kind_name(i: u32) -> [u8; 3] {
    [b'K', b'0' + (i / 10) as u8, b'0' + (i % 10) as u8]
}

#[test]
fn unknown_badge_is_not_found() {
    let w = world();
    assert_eq!(w.nft.try_get(&42), Err(Ok(Error::NotFound)));
    assert_eq!(w.nft.balance_of(&w.alice), 0);
    assert_eq!(w.nft.total_minted(), 0);
}
