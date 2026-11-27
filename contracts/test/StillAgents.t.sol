// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StillAgents} from "../src/StillAgents.sol";

/// @dev USDC's shape as Still's agents use it: balances, allowances, a permit that can be made to fail as a front-run one does.
contract MockUsdc {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public permitReverts;

    function mintTo(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function setPermitReverts(bool reverts) external {
        permitReverts = reverts;
    }

    function permit(address holder, address spender, uint256 value, uint256, uint8, bytes32, bytes32) external {
        require(!permitReverts, "permit used");
        allowance[holder][spender] = value;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(allowance[from][msg.sender] >= value, "allowance");
        require(balanceOf[from] >= value, "balance");
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}

/// @dev A payee that tries to mint again while it is being paid.
contract Reenterer {
    StillAgents public agents;

    function aim(StillAgents agents_) external {
        agents = agents_;
    }

    receive() external payable {
        agents.mint{value: msg.value}();
    }
}

contract StillAgentsTest is Test {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId);
    event Minted(address indexed holder, uint256 indexed tokenId, address currency, uint256 paid);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    StillAgents internal agents;
    MockUsdc internal usdc;

    address internal payee = address(0xBEEF);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    uint256 internal constant PRICE_WEI = 0.0002 ether;
    uint256 internal constant PRICE_USDC = 500_000;
    string internal constant BASE = "https://miorail.xyz/api/public/still/agents/nft/";

    function setUp() public {
        usdc = new MockUsdc();
        agents = new StillAgents(address(usdc), payee, PRICE_WEI, PRICE_USDC, BASE);
        agents.setMintOpen(true);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        usdc.mintTo(alice, 10_000_000);
        usdc.mintTo(bob, 10_000_000);
    }

    function idOf(address holder) internal pure returns (uint256) {
        return uint256(uint160(holder));
    }

    // --- ETH

    function test_mintWithEthPaysThePayeeAndBindsTheAgentToTheWallet() public {
        vm.expectEmit(true, true, true, true, address(agents));
        emit Transfer(address(0), alice, idOf(alice));
        vm.expectEmit(false, false, false, true, address(agents));
        emit Locked(idOf(alice));
        vm.expectEmit(true, true, false, true, address(agents));
        emit Minted(alice, idOf(alice), address(0), PRICE_WEI);
        vm.prank(alice);
        agents.mint{value: PRICE_WEI}();

        assertEq(agents.ownerOf(idOf(alice)), alice);
        assertEq(agents.balanceOf(alice), 1);
        assertEq(agents.totalSupply(), 1);
        assertTrue(agents.locked(idOf(alice)));
        assertEq(payee.balance, PRICE_WEI);
        assertEq(address(agents).balance, 0, "nothing is kept");
        assertEq(agents.tokenOf(alice), idOf(alice));
        assertEq(agents.tokenURI(idOf(alice)), "https://miorail.xyz/api/public/still/agents/nft/0x00000000000000000000000000000000000a11ce");
        assertEq(agents.contractURI(), "https://miorail.xyz/api/public/still/agents/nft/collection");
    }

    function test_mintWithEthRefusesAnyOtherAmount() public {
        vm.startPrank(alice);
        vm.expectRevert(StillAgents.WrongPayment.selector);
        agents.mint{value: PRICE_WEI - 1}();
        vm.expectRevert(StillAgents.WrongPayment.selector);
        agents.mint{value: PRICE_WEI + 1}();
        vm.expectRevert(StillAgents.WrongPayment.selector);
        agents.mint();
        vm.stopPrank();
        assertEq(agents.balanceOf(alice), 0);
    }

    function test_aBuilderCodeAfterTheCallIsIgnored() public {
        // ERC-8021: Still's site appends its Builder Code to the calldata.
        bytes memory call = abi.encodePacked(abi.encodeCall(StillAgents.mint, ()), hex"62635f7a3275756f3464740b0080218021802180218021802180218021");
        vm.prank(alice);
        (bool ok,) = address(agents).call{value: PRICE_WEI}(call);
        assertTrue(ok);
        assertEq(agents.ownerOf(idOf(alice)), alice);
    }

    // --- USDC

    function test_mintWithUsdcFromAnAllowance() public {
        vm.startPrank(alice);
        usdc.approve(address(agents), PRICE_USDC);
        vm.expectEmit(true, true, false, true, address(agents));
        emit Minted(alice, idOf(alice), address(usdc), PRICE_USDC);
        agents.mintWithUsdc();
        vm.stopPrank();
        assertEq(agents.ownerOf(idOf(alice)), alice);
        assertEq(usdc.balanceOf(payee), PRICE_USDC);
        assertEq(usdc.balanceOf(alice), 10_000_000 - PRICE_USDC);
        assertEq(usdc.balanceOf(address(agents)), 0, "nothing is kept");
    }

    function test_mintWithUsdcWithoutAnAllowanceMintsNothing() public {
        vm.prank(alice);
        vm.expectRevert(bytes("allowance"));
        agents.mintWithUsdc();
        assertEq(agents.balanceOf(alice), 0);
        assertEq(agents.totalSupply(), 0);
    }

    function test_mintWithAUsdcPermitInOneCall() public {
        vm.prank(alice);
        agents.mintWithUsdcPermit(block.timestamp + 600, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        assertEq(agents.ownerOf(idOf(alice)), alice);
        assertEq(usdc.balanceOf(payee), PRICE_USDC);
        assertEq(usdc.allowance(alice, address(agents)), 0);
    }

    function test_aPermitSomeoneSubmittedFirstStillMints() public {
        // The permit went in first, from somebody watching the pool; the allowance stands.
        usdc.setPermitReverts(true);
        vm.prank(alice);
        usdc.approve(address(agents), PRICE_USDC);
        vm.prank(alice);
        agents.mintWithUsdcPermit(block.timestamp + 600, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        assertEq(agents.ownerOf(idOf(alice)), alice);
    }

    // --- one per wallet, and minting can be closed

    function test_oneAgentPerWalletWhateverItPaysWith() public {
        vm.startPrank(alice);
        agents.mint{value: PRICE_WEI}();
        vm.expectRevert(StillAgents.AlreadyMinted.selector);
        agents.mint{value: PRICE_WEI}();
        usdc.approve(address(agents), PRICE_USDC);
        vm.expectRevert(StillAgents.AlreadyMinted.selector);
        agents.mintWithUsdc();
        vm.stopPrank();
        assertEq(payee.balance, PRICE_WEI, "a refused mint pays nothing");
        assertEq(usdc.balanceOf(payee), 0);
    }

    function test_closedMintingMintsNothing() public {
        agents.setMintOpen(false);
        vm.prank(alice);
        vm.expectRevert(StillAgents.MintClosed.selector);
        agents.mint{value: PRICE_WEI}();
    }

    function test_aZeroPriceClosesThatCurrencyOnly() public {
        agents.setPrices(0, PRICE_USDC);
        vm.prank(alice);
        vm.expectRevert(StillAgents.WrongPayment.selector);
        agents.mint();
        vm.startPrank(bob);
        usdc.approve(address(agents), PRICE_USDC);
        agents.mintWithUsdc();
        vm.stopPrank();
        assertEq(agents.balanceOf(bob), 1);
        agents.setPrices(PRICE_WEI, 0);
        vm.prank(alice);
        vm.expectRevert(StillAgents.WrongPayment.selector);
        agents.mintWithUsdc();
    }

    // --- bound to the wallet

    function test_noWayToMoveOrApproveAnAgent() public {
        vm.prank(alice);
        agents.mint{value: PRICE_WEI}();
        vm.startPrank(alice);
        vm.expectRevert(StillAgents.Soulbound.selector);
        agents.transferFrom(alice, bob, idOf(alice));
        vm.expectRevert(StillAgents.Soulbound.selector);
        agents.safeTransferFrom(alice, bob, idOf(alice));
        vm.expectRevert(StillAgents.Soulbound.selector);
        agents.safeTransferFrom(alice, bob, idOf(alice), "");
        vm.expectRevert(StillAgents.Soulbound.selector);
        agents.approve(bob, idOf(alice));
        vm.expectRevert(StillAgents.Soulbound.selector);
        agents.setApprovalForAll(bob, true);
        vm.stopPrank();
        assertEq(agents.getApproved(idOf(alice)), address(0));
        assertFalse(agents.isApprovedForAll(alice, bob));
        assertEq(agents.ownerOf(idOf(alice)), alice);
    }

    function test_onlyRealAgentsHaveAnOwner() public {
        vm.expectRevert(StillAgents.NoToken.selector);
        agents.ownerOf(idOf(alice));
        vm.prank(alice);
        agents.mint{value: PRICE_WEI}();
        vm.expectRevert(StillAgents.NoToken.selector);
        agents.ownerOf(idOf(alice) | (uint256(1) << 160));
        vm.expectRevert(StillAgents.NoToken.selector);
        agents.tokenURI(idOf(bob));
        vm.expectRevert(StillAgents.ZeroAddress.selector);
        agents.balanceOf(address(0));
    }

    function test_theHolderMayLetItGoAndMintAgainPayingAgain() public {
        vm.startPrank(alice);
        agents.mint{value: PRICE_WEI}();
        vm.expectEmit(true, true, true, true, address(agents));
        emit Transfer(alice, address(0), idOf(alice));
        agents.burn();
        assertEq(agents.balanceOf(alice), 0);
        assertEq(agents.totalSupply(), 0);
        vm.expectRevert(StillAgents.NoToken.selector);
        agents.burn();
        agents.mint{value: PRICE_WEI}();
        vm.stopPrank();
        assertEq(agents.ownerOf(idOf(alice)), alice);
        assertEq(payee.balance, 2 * PRICE_WEI);
    }

    function test_nobodyElseCanBurnAnAgent() public {
        vm.prank(alice);
        agents.mint{value: PRICE_WEI}();
        vm.prank(bob);
        vm.expectRevert(StillAgents.NoToken.selector);
        agents.burn();
        assertEq(agents.ownerOf(idOf(alice)), alice);
    }

    // --- the owner's settings

    function test_onlyTheOwnerChangesSettings() public {
        vm.startPrank(bob);
        vm.expectRevert(StillAgents.NotOwner.selector);
        agents.setPrices(1, 1);
        vm.expectRevert(StillAgents.NotOwner.selector);
        agents.setPayee(bob);
        vm.expectRevert(StillAgents.NotOwner.selector);
        agents.setMintOpen(false);
        vm.expectRevert(StillAgents.NotOwner.selector);
        agents.setBaseUri("https://evil.example/");
        vm.expectRevert(StillAgents.NotOwner.selector);
        agents.transferOwnership(bob);
        vm.stopPrank();
        vm.expectRevert(StillAgents.ZeroAddress.selector);
        agents.setPayee(address(0));
    }

    function test_ownershipMovesInTwoSteps() public {
        agents.transferOwnership(bob);
        assertEq(agents.owner(), address(this));
        vm.prank(alice);
        vm.expectRevert(StillAgents.NotOwner.selector);
        agents.acceptOwnership();
        vm.prank(bob);
        agents.acceptOwnership();
        assertEq(agents.owner(), bob);
        assertEq(agents.pendingOwner(), address(0));
        vm.expectRevert(StillAgents.NotOwner.selector);
        agents.setMintOpen(false);
    }

    function test_aNewPayeeIsPaidFromTheNextMint() public {
        agents.setPayee(bob);
        vm.prank(alice);
        agents.mint{value: PRICE_WEI}();
        assertEq(bob.balance, 1 ether + PRICE_WEI);
        assertEq(payee.balance, 0);
    }

    function test_aNewMetadataAddressIsSaidToMarketplaces() public {
        vm.prank(alice);
        agents.mint{value: PRICE_WEI}();
        vm.expectEmit(false, false, false, true, address(agents));
        emit BatchMetadataUpdate(0, type(uint160).max);
        agents.setBaseUri("https://still.example/nft/");
        assertEq(agents.tokenURI(idOf(alice)), "https://still.example/nft/0x00000000000000000000000000000000000a11ce");
    }

    function test_aPayeeThatMintsWhileBeingPaidUndoesTheWholeMint() public {
        Reenterer reenterer = new Reenterer();
        StillAgents guarded = new StillAgents(address(usdc), address(reenterer), PRICE_WEI, PRICE_USDC, BASE);
        reenterer.aim(guarded);
        guarded.setMintOpen(true);
        vm.prank(alice);
        vm.expectRevert(StillAgents.PayFailed.selector);
        guarded.mint{value: PRICE_WEI}();
        assertEq(guarded.balanceOf(alice), 0);
        assertEq(guarded.totalSupply(), 0);
    }

    function test_saysWhatItIs() public view {
        assertTrue(agents.supportsInterface(0x01ffc9a7));
        assertTrue(agents.supportsInterface(0x80ac58cd));
        assertTrue(agents.supportsInterface(0x5b5e139f));
        assertTrue(agents.supportsInterface(0xb45a3c0e));
        assertTrue(agents.supportsInterface(0x49064906));
        assertFalse(agents.supportsInterface(0xffffffff));
        assertEq(agents.name(), "Still Agents");
        assertEq(agents.symbol(), "STILLAGENT");
        assertEq(address(agents.usdc()), address(usdc));
        assertEq(agents.payee(), payee);
    }

    function test_refusesToStartWithoutUsdcOrAPayee() public {
        vm.expectRevert(StillAgents.ZeroAddress.selector);
        new StillAgents(address(0), payee, PRICE_WEI, PRICE_USDC, BASE);
        vm.expectRevert(StillAgents.ZeroAddress.selector);
        new StillAgents(address(usdc), address(0), PRICE_WEI, PRICE_USDC, BASE);
    }
}
