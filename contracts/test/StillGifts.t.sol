// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StillGifts} from "../src/StillGifts.sol";

// Coinbase's stock tokens (B20) run on Base-only opcodes that Foundry's EVM lacks: on a fork their transfer stops with
// OpcodeNotFound, so these tests use stand-in tokens. The real token was checked on Base itself with eth_call on
// 2026-11-23: SpaceX (SPCXc) sent by a contract (Aave V4's hub) to a wallet that never held any returned true, which is
// what a claim does from this contract.

/// @dev A stock token as Coinbase's answer a transfer: true, or a revert.
contract StockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external virtual returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

/// @dev A token whose transfer answers nothing (as some old tokens do).
contract SilentToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
    }
}

/// @dev A token whose transfer says false and moves nothing.
contract RefusingToken {
    function balanceOf(address) external pure returns (uint256) {
        return 1e30;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev A token that tries to claim again from inside its own transfer, then sends as asked.
contract ReenteringToken is StockToken {
    StillGifts internal gifts;
    bytes internal again;
    bool public refused;

    function arm(StillGifts gifts_, bytes memory again_) external {
        gifts = gifts_;
        again = again_;
    }

    function transfer(address to, uint256 value) external override returns (bool) {
        if (address(gifts) != address(0)) {
            (bool ok, bytes memory reason) = address(gifts).call(again);
            require(!ok && reason.length == 4 && bytes4(reason) == StillGifts.Reentered.selector, "the claim from inside was not refused");
            refused = true;
        }
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

contract StillGiftsTest is Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE5;
    uint256 internal constant OTHER_KEY = 0xB0B5;
    uint8 internal constant SWAP = 0;
    uint8 internal constant SPEND = 2;

    StillGifts internal gifts;
    StockToken internal spacex;
    address internal signer;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    event Claimed(address indexed wallet, uint8 indexed kind, address indexed token, uint256 amount);

    function setUp() public {
        vm.chainId(8453);
        vm.warp(1_795_000_000);
        signer = vm.addr(SIGNER_KEY);
        gifts = new StillGifts(signer);
        spacex = new StockToken();
        spacex.mint(address(gifts), 1_000_000);
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = address(spacex);
        amounts[0] = 5_000;
        gifts.setMaxAmounts(tokens, amounts);
    }

    function sign(uint256 key, address wallet, uint8 kind, address token, uint256 amount, uint256 deadline) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, gifts.giftDigest(wallet, kind, token, amount, deadline));
        return abi.encodePacked(r, s, v);
    }

    function claimAs(address wallet, uint8 kind, address token, uint256 amount, uint256 deadline, bytes memory signature) internal {
        vm.prank(wallet);
        gifts.claim(kind, token, amount, deadline, signature);
    }

    function test_aSignedGiftGoesToTheWalletThatClaimsIt() public {
        uint256 deadline = block.timestamp + 1800;
        bytes memory signature = sign(SIGNER_KEY, alice, SWAP, address(spacex), 1_234, deadline);
        vm.expectEmit(true, true, true, true, address(gifts));
        emit Claimed(alice, SWAP, address(spacex), 1_234);
        claimAs(alice, SWAP, address(spacex), 1_234, deadline, signature);
        assertEq(spacex.balanceOf(alice), 1_234);
        assertEq(spacex.balanceOf(address(gifts)), 1_000_000 - 1_234);
        assertTrue(gifts.claimed(alice, SWAP));
        assertFalse(gifts.claimed(alice, SPEND));
        assertEq(gifts.claimedKinds(alice), 1);
    }

    function test_oneGiftForEachKindOfActionPerWallet() public {
        uint256 deadline = block.timestamp + 1800;
        claimAs(alice, SWAP, address(spacex), 100, deadline, sign(SIGNER_KEY, alice, SWAP, address(spacex), 100, deadline));
        bytes memory again = sign(SIGNER_KEY, alice, SWAP, address(spacex), 99, deadline);
        vm.prank(alice);
        vm.expectRevert(StillGifts.AlreadyClaimed.selector);
        gifts.claim(SWAP, address(spacex), 99, deadline, again);
        // Another kind is another gift; the highest kind a byte can name works too.
        claimAs(alice, SPEND, address(spacex), 200, deadline, sign(SIGNER_KEY, alice, SPEND, address(spacex), 200, deadline));
        claimAs(alice, 255, address(spacex), 300, deadline, sign(SIGNER_KEY, alice, 255, address(spacex), 300, deadline));
        assertEq(spacex.balanceOf(alice), 600);
        assertEq(gifts.claimedKinds(alice), (uint256(1) << 255) | 4 | 1);
    }

    function test_aGiftSignedForOneWalletIsNotAnotherWallets() public {
        uint256 deadline = block.timestamp + 1800;
        bytes memory forAlice = sign(SIGNER_KEY, alice, SWAP, address(spacex), 100, deadline);
        vm.prank(bob);
        vm.expectRevert(StillGifts.BadSignature.selector);
        gifts.claim(SWAP, address(spacex), 100, deadline, forAlice);
        assertEq(spacex.balanceOf(bob), 0);
    }

    function test_onlyTheSignersSignatureCounts() public {
        uint256 deadline = block.timestamp + 1800;
        bytes memory forged = sign(OTHER_KEY, alice, SWAP, address(spacex), 100, deadline);
        vm.prank(alice);
        vm.expectRevert(StillGifts.BadSignature.selector);
        gifts.claim(SWAP, address(spacex), 100, deadline, forged);
    }

    function test_anyChangeToTheGiftBreaksItsSignature() public {
        uint256 deadline = block.timestamp + 1800;
        bytes memory signature = sign(SIGNER_KEY, alice, SWAP, address(spacex), 100, deadline);
        StockToken other = new StockToken();
        other.mint(address(gifts), 1_000);
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = address(other);
        amounts[0] = 1_000;
        gifts.setMaxAmounts(tokens, amounts);
        vm.startPrank(alice);
        vm.expectRevert(StillGifts.BadSignature.selector);
        gifts.claim(SWAP, address(spacex), 101, deadline, signature);
        vm.expectRevert(StillGifts.BadSignature.selector);
        gifts.claim(SPEND, address(spacex), 100, deadline, signature);
        vm.expectRevert(StillGifts.BadSignature.selector);
        gifts.claim(SWAP, address(other), 100, deadline, signature);
        vm.expectRevert(StillGifts.BadSignature.selector);
        gifts.claim(SWAP, address(spacex), 100, deadline + 1, signature);
        vm.stopPrank();
    }

    function test_aGiftLapsesAtItsDeadline() public {
        uint256 deadline = block.timestamp + 1800;
        bytes memory signature = sign(SIGNER_KEY, alice, SWAP, address(spacex), 100, deadline);
        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(StillGifts.Expired.selector);
        gifts.claim(SWAP, address(spacex), 100, deadline, signature);
        vm.warp(deadline);
        claimAs(alice, SWAP, address(spacex), 100, deadline, signature);
        assertEq(spacex.balanceOf(alice), 100);
    }

    function test_onlyListedTokensWithinTheirBound() public {
        uint256 deadline = block.timestamp + 1800;
        StockToken unlisted = new StockToken();
        unlisted.mint(address(gifts), 1_000);
        // Each signature is made first: making one reads the contract, which would take the prank and the expected revert.
        bytes memory forUnlisted = sign(SIGNER_KEY, alice, SWAP, address(unlisted), 100, deadline);
        bytes memory overMax = sign(SIGNER_KEY, alice, SWAP, address(spacex), 5_001, deadline);
        bytes memory zero = sign(SIGNER_KEY, alice, SWAP, address(spacex), 0, deadline);
        vm.prank(alice);
        vm.expectRevert(StillGifts.NotOffered.selector);
        gifts.claim(SWAP, address(unlisted), 100, deadline, forUnlisted);
        vm.prank(alice);
        vm.expectRevert(StillGifts.OverMax.selector);
        gifts.claim(SWAP, address(spacex), 5_001, deadline, overMax);
        vm.prank(alice);
        vm.expectRevert(StillGifts.OverMax.selector);
        gifts.claim(SWAP, address(spacex), 0, deadline, zero);
        claimAs(alice, SWAP, address(spacex), 5_000, deadline, sign(SIGNER_KEY, alice, SWAP, address(spacex), 5_000, deadline));
        // Off the list again: a gift signed before is not paid.
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = address(spacex);
        gifts.setMaxAmounts(tokens, amounts);
        bytes memory forBob = sign(SIGNER_KEY, bob, SWAP, address(spacex), 100, deadline);
        vm.prank(bob);
        vm.expectRevert(StillGifts.NotOffered.selector);
        gifts.claim(SWAP, address(spacex), 100, deadline, forBob);
    }

    function test_pausedClaimsNothingUntilResumed() public {
        uint256 deadline = block.timestamp + 1800;
        bytes memory signature = sign(SIGNER_KEY, alice, SWAP, address(spacex), 100, deadline);
        gifts.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(StillGifts.ClaimsPaused.selector);
        gifts.claim(SWAP, address(spacex), 100, deadline, signature);
        gifts.setPaused(false);
        claimAs(alice, SWAP, address(spacex), 100, deadline, signature);
        assertEq(spacex.balanceOf(alice), 100);
    }

    function test_aMirroredOrMalformedSignatureIsRefused() public {
        uint256 deadline = block.timestamp + 1800;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, gifts.giftDigest(alice, SWAP, address(spacex), 100, deadline));
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory mirrored = abi.encodePacked(r, bytes32(order - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.startPrank(alice);
        vm.expectRevert(StillGifts.BadSignature.selector);
        gifts.claim(SWAP, address(spacex), 100, deadline, mirrored);
        vm.expectRevert(StillGifts.BadSignature.selector);
        gifts.claim(SWAP, address(spacex), 100, deadline, abi.encodePacked(r, s, uint8(v - 27)));
        vm.expectRevert(StillGifts.BadSignature.selector);
        gifts.claim(SWAP, address(spacex), 100, deadline, abi.encodePacked(r, s));
        vm.expectRevert(StillGifts.BadSignature.selector);
        gifts.claim(SWAP, address(spacex), 100, deadline, abi.encodePacked(bytes32(0), bytes32(0), uint8(27)));
        vm.stopPrank();
    }

    function test_aTokenThatAnswersNothingIsSentAndOneThatSaysFalseIsNot() public {
        uint256 deadline = block.timestamp + 1800;
        SilentToken silent = new SilentToken();
        silent.mint(address(gifts), 1_000);
        RefusingToken refusing = new RefusingToken();
        address[] memory tokens = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        (tokens[0], tokens[1], tokens[2]) = (address(silent), address(refusing), address(0xE0A));
        (amounts[0], amounts[1], amounts[2]) = (500, 500, 500);
        gifts.setMaxAmounts(tokens, amounts);
        claimAs(alice, SWAP, address(silent), 300, deadline, sign(SIGNER_KEY, alice, SWAP, address(silent), 300, deadline));
        assertEq(silent.balanceOf(alice), 300);
        bytes memory forRefusing = sign(SIGNER_KEY, alice, SPEND, address(refusing), 300, deadline);
        bytes memory forNoCode = sign(SIGNER_KEY, alice, SPEND, address(0xE0A), 300, deadline);
        vm.prank(alice);
        vm.expectRevert(StillGifts.TransferFailed.selector);
        gifts.claim(SPEND, address(refusing), 300, deadline, forRefusing);
        assertFalse(gifts.claimed(alice, SPEND), "a gift that was not sent is not claimed");
        // An address with no code would "succeed" at anything: it is never taken for a token.
        vm.prank(alice);
        vm.expectRevert(StillGifts.TransferFailed.selector);
        gifts.claim(SPEND, address(0xE0A), 300, deadline, forNoCode);
    }

    function test_aGiftLargerThanWhatIsLeftIsNotHalfSent() public {
        uint256 deadline = block.timestamp + 1800;
        StockToken thin = new StockToken();
        thin.mint(address(gifts), 50);
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = address(thin);
        amounts[0] = 500;
        gifts.setMaxAmounts(tokens, amounts);
        bytes memory signature = sign(SIGNER_KEY, alice, SWAP, address(thin), 100, deadline);
        vm.prank(alice);
        vm.expectRevert();
        gifts.claim(SWAP, address(thin), 100, deadline, signature);
        assertFalse(gifts.claimed(alice, SWAP));
        assertEq(thin.balanceOf(address(gifts)), 50);
    }

    function test_aTokenCannotClaimAgainWhileItIsBeingSent() public {
        uint256 deadline = block.timestamp + 1800;
        ReenteringToken sly = new ReenteringToken();
        sly.mint(address(gifts), 1_000);
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = address(sly);
        amounts[0] = 1_000;
        gifts.setMaxAmounts(tokens, amounts);
        sly.arm(gifts, abi.encodeCall(StillGifts.claim, (SPEND, address(sly), 100, deadline, sign(SIGNER_KEY, address(sly), SPEND, address(sly), 100, deadline))));
        bytes memory signature = sign(SIGNER_KEY, alice, SWAP, address(sly), 100, deadline);
        claimAs(alice, SWAP, address(sly), 100, deadline, signature);
        assertTrue(sly.refused(), "the claim from inside the transfer was refused as reentered");
        assertFalse(gifts.claimed(address(sly), SPEND));
        assertEq(sly.balanceOf(address(sly)), 0);
        assertEq(sly.balanceOf(alice), 100);
    }

    function test_aBuilderCodeAfterTheCallIsIgnored() public {
        uint256 deadline = block.timestamp + 1800;
        bytes memory call = abi.encodeCall(StillGifts.claim, (SWAP, address(spacex), 100, deadline, sign(SIGNER_KEY, alice, SWAP, address(spacex), 100, deadline)));
        // ERC-8021: the codes, their length, the schema id and the marker, after the call's own data.
        bytes memory suffix = abi.encodePacked("bc_z2uuo4dt", uint8(11), uint8(0), bytes16(0x80218021802180218021802180218021));
        vm.prank(alice);
        (bool ok,) = address(gifts).call(bytes.concat(call, suffix));
        assertTrue(ok);
        assertEq(spacex.balanceOf(alice), 100);
    }

    function test_onlyTheOwnerChangesSettingsOrTakesTokensBack() public {
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = address(spacex);
        vm.startPrank(bob);
        vm.expectRevert(StillGifts.NotOwner.selector);
        gifts.setSigner(bob);
        vm.expectRevert(StillGifts.NotOwner.selector);
        gifts.setMaxAmounts(tokens, amounts);
        vm.expectRevert(StillGifts.NotOwner.selector);
        gifts.setPaused(true);
        vm.expectRevert(StillGifts.NotOwner.selector);
        gifts.withdraw(address(spacex), bob, 1);
        vm.expectRevert(StillGifts.NotOwner.selector);
        gifts.transferOwnership(bob);
        vm.stopPrank();
        gifts.withdraw(address(spacex), address(this), 400_000);
        assertEq(spacex.balanceOf(address(this)), 400_000);
        vm.expectRevert(StillGifts.ZeroAddress.selector);
        gifts.withdraw(address(spacex), address(0), 1);
        vm.expectRevert(StillGifts.LengthMismatch.selector);
        gifts.setMaxAmounts(tokens, new uint256[](0));
        vm.expectRevert(StillGifts.ZeroAddress.selector);
        gifts.setSigner(address(0));
    }

    function test_aNewSignerSignsFromThenOn() public {
        uint256 deadline = block.timestamp + 1800;
        bytes memory old = sign(SIGNER_KEY, alice, SWAP, address(spacex), 100, deadline);
        gifts.setSigner(vm.addr(OTHER_KEY));
        vm.prank(alice);
        vm.expectRevert(StillGifts.BadSignature.selector);
        gifts.claim(SWAP, address(spacex), 100, deadline, old);
        claimAs(alice, SWAP, address(spacex), 100, deadline, sign(OTHER_KEY, alice, SWAP, address(spacex), 100, deadline));
    }

    function test_ownershipMovesInTwoSteps() public {
        gifts.transferOwnership(bob);
        assertEq(gifts.owner(), address(this));
        vm.prank(alice);
        vm.expectRevert(StillGifts.NotOwner.selector);
        gifts.acceptOwnership();
        vm.prank(bob);
        gifts.acceptOwnership();
        assertEq(gifts.owner(), bob);
        assertEq(gifts.pendingOwner(), address(0));
    }

    function test_theSignedTextIsEip712ForThisContractOnThisChain() public view {
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Still Gifts"), keccak256("1"), uint256(8453), address(gifts)
        ));
        assertEq(gifts.domainSeparator(), domain);
        bytes32 gift = keccak256(abi.encode(
            keccak256("Gift(address wallet,uint8 kind,address token,uint256 amount,uint256 deadline)"),
            alice, uint8(3), address(spacex), uint256(42), uint256(7)
        ));
        assertEq(gifts.giftDigest(alice, 3, address(spacex), 42, 7), keccak256(abi.encodePacked("\x19\x01", domain, gift)));
        assertEq(gifts.name(), "Still Gifts");
        assertEq(gifts.version(), "1");
    }

    function test_refusesToStartWithoutASigner() public {
        vm.expectRevert(StillGifts.ZeroAddress.selector);
        new StillGifts(address(0));
    }
}
