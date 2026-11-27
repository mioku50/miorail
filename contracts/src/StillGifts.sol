// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

/// @notice The part of a stock token (Coinbase's tokenized stocks on Base) a gift needs.
interface IStillGiftTokenV1 {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address holder) external view returns (uint256);
}

/// @title Still Gifts
/// @notice Pieces of stock a person earns by using Still (miorail.xyz) and claims with their own transaction: one gift
/// for each kind of action, per wallet. Still's server says which gift a wallet has earned by signing it (EIP-712);
/// this contract checks that signature, that the wallet has not claimed a gift for that kind of action before, and that
/// the amount is within the owner's bound for that token, then sends the token to the wallet that claims.
/// @dev It holds only what its owner puts in, and the owner can take it back at any time. The owner can set the
/// signer, each token's bound (zero takes a token off the list) and pause claims, and nothing else: a claimed gift is
/// the claimer's, and a wallet's claims are never undone.
contract StillGifts {
    /// @notice `kind` is the kind of action the gift was earned by, as Still numbers them.
    event Claimed(address indexed wallet, uint8 indexed kind, address indexed token, uint256 amount);
    event SignerSet(address signer);
    event MaxAmountSet(address indexed token, uint256 maxAmount);
    event PausedSet(bool paused);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error ClaimsPaused();
    error Expired();
    error AlreadyClaimed();
    error NotOffered();
    error OverMax();
    error BadSignature();
    error TransferFailed();
    error LengthMismatch();
    error Reentered();

    string public constant name = "Still Gifts";
    string public constant version = "1";
    bytes32 public constant GIFT_TYPEHASH =
        keccak256("Gift(address wallet,uint8 kind,address token,uint256 amount,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev secp256k1's order halved: a signature with a larger s is the same signature mirrored, refused (EIP-2).
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public owner;
    address public pendingOwner;
    /// @notice The key Still's server signs gifts with.
    address public signer;
    bool public paused;
    /// @notice The most one gift of a token may be, in its smallest unit; zero means the token is not given.
    mapping(address => uint256) public maxAmount;
    /// @notice Each wallet's claimed kinds, one bit per kind.
    mapping(address => uint256) public claimedKinds;

    uint256 private entered = 1;

    constructor(address signer_) {
        if (signer_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        signer = signer_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit SignerSet(signer_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (entered != 1) revert Reentered();
        entered = 2;
        _;
        entered = 1;
    }

    // --- reads

    /// @notice Whether `wallet` has claimed its gift for `kind`.
    function claimed(address wallet, uint8 kind) external view returns (bool) {
        return claimedKinds[wallet] & (uint256(1) << kind) != 0;
    }

    /// @notice EIP-712's domain: this contract, on this chain.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)));
    }

    /// @notice What Still's server signs for a gift.
    function giftDigest(address wallet, uint8 kind, address token, uint256 amount, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01", domainSeparator(), keccak256(abi.encode(GIFT_TYPEHASH, wallet, kind, token, amount, deadline))
        ));
    }

    // --- claiming: the wallet itself, once per kind

    /// @notice Sends the caller the gift Still signed for it: `amount` of `token`, for the kind of action `kind`.
    function claim(uint8 kind, address token, uint256 amount, uint256 deadline, bytes calldata signature) external nonReentrant {
        if (paused) revert ClaimsPaused();
        if (block.timestamp > deadline) revert Expired();
        uint256 bit = uint256(1) << kind;
        uint256 kinds = claimedKinds[msg.sender];
        if (kinds & bit != 0) revert AlreadyClaimed();
        uint256 max = maxAmount[token];
        if (max == 0) revert NotOffered();
        if (amount == 0 || amount > max) revert OverMax();
        if (_recover(giftDigest(msg.sender, kind, token, amount, deadline), signature) != signer) revert BadSignature();
        claimedKinds[msg.sender] = kinds | bit;
        _send(token, msg.sender, amount);
        emit Claimed(msg.sender, kind, token, amount);
    }

    // --- the owner's settings

    function setSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerSet(signer_);
    }

    /// @notice Sets each token's bound for one gift; zero takes the token off the list.
    function setMaxAmounts(address[] calldata tokens, uint256[] calldata amounts) external onlyOwner {
        if (tokens.length != amounts.length) revert LengthMismatch();
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            maxAmount[tokens[i]] = amounts[i];
            emit MaxAmountSet(tokens[i], amounts[i]);
        }
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Takes tokens back out: what the owner put in stays the owner's.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _send(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @notice Two steps, so a mistyped address cannot take the settings.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // --- helpers

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address who) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) revert BadSignature();
        who = ecrecover(digest, v, r, s);
        if (who == address(0)) revert BadSignature();
    }

    /// @dev A token that answers nothing is taken at its word only when it is a contract and did not revert.
    function _send(address token, address to, uint256 amount) private {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IStillGiftTokenV1.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) revert TransferFailed();
    }
}
