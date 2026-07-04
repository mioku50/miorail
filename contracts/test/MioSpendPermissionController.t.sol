// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../src/MioSpendPermissionController.sol";

contract MockERC20 {
    string public name = "Mock USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MioSpendPermissionControllerTest is Test {
    MioSpendPermissionController public controller;
    MockERC20 public token;

    address public owner = address(0x111);
    address public executor = address(0x222);
    address public target1 = address(0x333);
    address public target2 = address(0x444);
    address public unauthorized = address(0x999);

    function setUp() public {
        controller = new MioSpendPermissionController();
        token = new MockERC20();

        // Mint tokens to owner and approve controller
        token.mint(owner, 10_000 * 1e6);
        vm.prank(owner);
        token.approve(address(controller), type(uint256).max);
    }

    function _configureDefaultPermission() internal {
        address[] memory whitelist = new address[](2);
        whitelist[0] = target1;
        whitelist[1] = target2;

        vm.prank(owner);
        controller.configurePermission(
            executor,
            address(token),
            1000 * 1e6, // dailyLimit
            200 * 1e6,  // maxPerAction
            uint64(block.timestamp),
            uint64(block.timestamp + 7 days),
            whitelist
        );
    }

    function testConfigurePermission() public {
        _configureDefaultPermission();

        MioSpendPermissionController.SpendPermission memory perm = controller.getPermission(owner, executor, address(token));
        assertEq(perm.owner, owner);
        assertEq(perm.executor, executor);
        assertEq(perm.token, address(token));
        assertEq(perm.dailyLimit, 1000 * 1e6);
        assertEq(perm.maxPerAction, 200 * 1e6);
        assertEq(perm.validAfter, uint64(block.timestamp));
        assertEq(perm.validUntil, uint64(block.timestamp + 7 days));
        assertEq(perm.revoked, false);
        assertEq(perm.whitelist.length, 2);
        assertEq(perm.whitelist[0], target1);
        assertEq(perm.whitelist[1], target2);
        assertEq(perm.spentToday, 0);
        assertEq(perm.nonce, 0);
    }

    function testRevokePermission() public {
        _configureDefaultPermission();

        vm.prank(owner);
        controller.revokePermission(executor, address(token));

        MioSpendPermissionController.SpendPermission memory perm = controller.getPermission(owner, executor, address(token));
        assertEq(perm.revoked, true);

        vm.prank(executor);
        vm.expectRevert("Permission revoked");
        controller.executeSpend(owner, address(token), target1, 50 * 1e6);
    }

    function testRejectExpiredPermission() public {
        _configureDefaultPermission();

        vm.warp(block.timestamp + 8 days);

        vm.prank(executor);
        vm.expectRevert("Permission expired");
        controller.executeSpend(owner, address(token), target1, 50 * 1e6);
    }

    function testRejectWrongExecutor() public {
        _configureDefaultPermission();

        vm.prank(unauthorized);
        vm.expectRevert("Permission does not exist");
        controller.executeSpend(owner, address(token), target1, 50 * 1e6);
    }

    function testRejectNonWhitelistedTarget() public {
        _configureDefaultPermission();

        vm.prank(executor);
        vm.expectRevert("Target not whitelisted");
        controller.executeSpend(owner, address(token), unauthorized, 50 * 1e6);
    }

    function testRejectOverMaxPerAction() public {
        _configureDefaultPermission();

        vm.prank(executor);
        vm.expectRevert("Exceeds max per action");
        controller.executeSpend(owner, address(token), target1, 250 * 1e6); // max is 200
    }

    function testRejectOverDailyLimit() public {
        _configureDefaultPermission();

        vm.startPrank(executor);
        controller.executeSpend(owner, address(token), target1, 200 * 1e6);
        controller.executeSpend(owner, address(token), target1, 200 * 1e6);
        controller.executeSpend(owner, address(token), target1, 200 * 1e6);
        controller.executeSpend(owner, address(token), target1, 200 * 1e6);
        controller.executeSpend(owner, address(token), target1, 200 * 1e6); // 1000 total spent

        vm.expectRevert("Exceeds daily limit");
        controller.executeSpend(owner, address(token), target1, 50 * 1e6);
        vm.stopPrank();

        // Warp 24 hours, should reset daily limit
        vm.warp(block.timestamp + 86400);
        vm.prank(executor);
        bool success = controller.executeSpend(owner, address(token), target1, 100 * 1e6);
        assertTrue(success);
    }

    function testRejectReplayNonce() public {
        _configureDefaultPermission();

        vm.prank(executor);
        controller.executeSpend(owner, address(token), target1, 50 * 1e6, 0);

        vm.prank(executor);
        vm.expectRevert("Invalid replay nonce");
        controller.executeSpend(owner, address(token), target1, 50 * 1e6, 0);
    }
}
