// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StillAgents} from "../src/StillAgents.sol";

interface IUsdcFull {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address holder) external view returns (uint256);
    function nonces(address holder) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function approve(address spender, uint256 value) external returns (bool);
}

/// @notice Against Base itself, with Circle's own USDC: a permit signed as a wallet signs it mints in one call.
/// Runs only with BASE_FORK_RPC set (forge test --match-path test/StillAgentsFork.t.sol), as it reads a chain.
contract StillAgentsForkTest is Test {
    IUsdcFull internal constant USDC = IUsdcFull(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    /// @dev Morpho Blue on Base holds USDC: the test borrows a dollar's worth of its balance, on the fork only.
    address internal constant HOLDER = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    address internal payee;
    StillAgents internal agents;

    /// @dev A wallet no one has used on Base: Foundry's makeAddr("alice") key is public, and on Base its address carries an
    /// EIP-7702 delegation, so USDC reads its permits as a contract's (ERC-1271) and refuses an ECDSA signature.
    function freshWallet(string memory label) internal returns (address wallet, uint256 key) {
        key = uint256(keccak256(abi.encode("still-agents-fork", label, block.number)));
        wallet = vm.addr(key);
        assertEq(wallet.code.length, 0, "a wallet with code signs permits as a contract");
        assertEq(USDC.balanceOf(wallet), 0);
    }

    function setUp() public {
        string memory rpc = vm.envOr("BASE_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        (payee,) = freshWallet("payee");
        agents = new StillAgents(address(USDC), payee, 0.0002 ether, 500_000, "https://miorail.xyz/api/public/still/agents/nft/");
        agents.setMintOpen(true);
    }

    function test_aRealUsdcPermitMintsInOneCall() public {
        (address alice, uint256 key) = freshWallet("alice");
        vm.prank(HOLDER);
        USDC.transfer(alice, 1_000_000);
        uint256 deadline = block.timestamp + 600;
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            USDC.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(PERMIT_TYPEHASH, alice, address(agents), 500_000, USDC.nonces(alice), deadline))
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        vm.prank(alice);
        agents.mintWithUsdcPermit(deadline, v, r, s);
        assertEq(agents.ownerOf(uint256(uint160(alice))), alice);
        assertEq(USDC.balanceOf(payee), 500_000);
        assertEq(USDC.balanceOf(alice), 500_000);
        assertEq(USDC.balanceOf(address(agents)), 0);
    }

    function test_realUsdcFromAnApprovalAndEthBothPay() public {
        (address bob,) = freshWallet("bob");
        vm.prank(HOLDER);
        USDC.transfer(bob, 1_000_000);
        vm.startPrank(bob);
        USDC.approve(address(agents), 500_000);
        agents.mintWithUsdc();
        vm.stopPrank();
        assertEq(USDC.balanceOf(payee), 500_000);
        (address carol,) = freshWallet("carol");
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        agents.mint{value: 0.0002 ether}();
        assertEq(payee.balance, 0.0002 ether);
        assertEq(agents.totalSupply(), 2);
    }
}
