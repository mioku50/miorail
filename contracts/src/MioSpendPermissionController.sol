// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

contract MioSpendPermissionController {
    struct SpendPermission {
        address owner;
        address executor;
        address token;
        uint256 dailyLimit;
        uint256 maxPerAction;
        uint64 validAfter;
        uint64 validUntil;
        bool revoked;
        address[] whitelist;
        uint256 spentToday;
        uint64 dayStart;
        uint256 nonce;
    }

    // mapping: owner => executor => token => SpendPermission
    mapping(address => mapping(address => mapping(address => SpendPermission))) private _permissions;

    event PermissionConfigured(
        address indexed owner,
        address indexed executor,
        address indexed token,
        uint256 dailyLimit,
        uint256 maxPerAction,
        uint64 validAfter,
        uint64 validUntil,
        address[] whitelist
    );

    event PermissionRevoked(address indexed owner, address indexed executor, address indexed token);

    event SpendExecuted(
        address indexed owner,
        address indexed executor,
        address indexed token,
        address target,
        uint256 amount,
        uint256 spentToday
    );

    event SpendBlocked(
        address indexed owner,
        address indexed executor,
        address indexed token,
        address target,
        uint256 amount,
        string reason
    );

    function configurePermission(
        address executor,
        address token,
        uint256 dailyLimit,
        uint256 maxPerAction,
        uint64 validAfter,
        uint64 validUntil,
        address[] calldata whitelist
    ) external {
        require(executor != address(0), "Invalid executor");
        require(token != address(0), "Invalid token");
        require(validUntil > block.timestamp, "Invalid validUntil");
        require(validUntil >= validAfter, "Invalid valid window");

        SpendPermission storage perm = _permissions[msg.sender][executor][token];
        perm.owner = msg.sender;
        perm.executor = executor;
        perm.token = token;
        perm.dailyLimit = dailyLimit;
        perm.maxPerAction = maxPerAction;
        perm.validAfter = validAfter;
        perm.validUntil = validUntil;
        perm.revoked = false;
        perm.whitelist = whitelist;
        perm.spentToday = 0;
        perm.dayStart = uint64(block.timestamp);
        // We preserve nonce across reconfigurations as a replay guard

        emit PermissionConfigured(
            msg.sender,
            executor,
            token,
            dailyLimit,
            maxPerAction,
            validAfter,
            validUntil,
            whitelist
        );
    }

    function revokePermission(address executor, address token) external {
        SpendPermission storage perm = _permissions[msg.sender][executor][token];
        require(perm.owner == msg.sender, "Permission does not exist");
        require(!perm.revoked, "Already revoked");
        perm.revoked = true;
        emit PermissionRevoked(msg.sender, executor, token);
    }

    function revokePermission(address owner, address executor, address token) external {
        require(msg.sender == owner, "Not authorized");
        SpendPermission storage perm = _permissions[owner][executor][token];
        require(perm.owner == owner, "Permission does not exist");
        require(!perm.revoked, "Already revoked");
        perm.revoked = true;
        emit PermissionRevoked(owner, executor, token);
    }

    function executeSpend(
        address owner,
        address token,
        address target,
        uint256 amount
    ) external returns (bool) {
        SpendPermission storage perm = _permissions[owner][msg.sender][token];
        return _execute(perm, owner, token, target, amount, perm.nonce, false);
    }

    function executeSpend(
        address owner,
        address token,
        address target,
        uint256 amount,
        uint256 nonce
    ) external returns (bool) {
        SpendPermission storage perm = _permissions[owner][msg.sender][token];
        return _execute(perm, owner, token, target, amount, nonce, true);
    }

    function _execute(
        SpendPermission storage perm,
        address owner,
        address token,
        address target,
        uint256 amount,
        uint256 nonce,
        bool checkNonce
    ) internal returns (bool) {
        if (perm.owner != owner || perm.executor != msg.sender || perm.token != token) {
            emit SpendBlocked(owner, msg.sender, token, target, amount, "Permission does not exist");
            revert("Permission does not exist");
        }
        if (perm.revoked) {
            emit SpendBlocked(owner, msg.sender, token, target, amount, "Permission revoked");
            revert("Permission revoked");
        }
        if (block.timestamp < perm.validAfter || block.timestamp > perm.validUntil) {
            emit SpendBlocked(owner, msg.sender, token, target, amount, "Permission expired");
            revert("Permission expired");
        }
        if (checkNonce && nonce != perm.nonce) {
            emit SpendBlocked(owner, msg.sender, token, target, amount, "Invalid replay nonce");
            revert("Invalid replay nonce");
        }
        if (amount > perm.maxPerAction) {
            emit SpendBlocked(owner, msg.sender, token, target, amount, "Exceeds max per action");
            revert("Exceeds max per action");
        }

        if (block.timestamp >= uint256(perm.dayStart) + 86400) {
            perm.spentToday = 0;
            perm.dayStart = uint64(block.timestamp);
        }

        if (perm.spentToday + amount > perm.dailyLimit) {
            emit SpendBlocked(owner, msg.sender, token, target, amount, "Exceeds daily limit");
            revert("Exceeds daily limit");
        }

        bool isWhitelisted = false;
        uint256 len = perm.whitelist.length;
        for (uint256 i = 0; i < len; i++) {
            if (perm.whitelist[i] == target) {
                isWhitelisted = true;
                break;
            }
        }
        if (!isWhitelisted) {
            emit SpendBlocked(owner, msg.sender, token, target, amount, "Target not whitelisted");
            revert("Target not whitelisted");
        }

        perm.spentToday += amount;
        perm.nonce += 1;

        bool success = IERC20(token).transferFrom(owner, target, amount);
        require(success, "Token transfer failed");

        emit SpendExecuted(owner, msg.sender, token, target, amount, perm.spentToday);
        return true;
    }

    function getPermission(
        address owner,
        address executor,
        address token
    ) external view returns (SpendPermission memory) {
        return _permissions[owner][executor][token];
    }
}
