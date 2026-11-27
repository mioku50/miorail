// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

/// @notice USDC on Base, as Still's agents are paid with it: Circle's FiatToken, with EIP-2612 permits.
interface IUsdcV1 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/// @title Still Agents
/// @notice One Still Agent per wallet, minted on Still (miorail.xyz) for ETH or for USDC, and bound to the wallet for
/// good: it cannot be sold, sent or approved to anyone (ERC-5192). Its token id is the wallet itself, so a wallet holds
/// at most one and the id never names anybody else. Its name and picture are read from Still (tokenURI), which is how
/// a name that should not be shown can be hidden; nothing about them is written here.
/// @dev Nothing is kept: each payment goes to the payee in the same call. The owner can set the prices, the payee, the
/// metadata address and whether minting is open, and nothing else: no token can be taken, moved or burned by anyone but
/// the wallet that holds it.
contract StillAgents {
    // --- ERC-721, ERC-5192 and ERC-4906 events
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Locked(uint256 tokenId);
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    // --- Still's own events
    /// @notice `currency` is address(0) for ETH, else the USDC contract; `paid` is in its smallest unit.
    event Minted(address indexed holder, uint256 indexed tokenId, address currency, uint256 paid);
    event PricesSet(uint256 priceWei, uint256 priceUsdc);
    event PayeeSet(address payee);
    event MintOpenSet(bool open);
    event BaseUriSet(string baseUri);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Soulbound();
    error AlreadyMinted();
    error WrongPayment();
    error MintClosed();
    error NotOwner();
    error NoToken();
    error PayFailed();
    error ZeroAddress();
    error Reentered();

    string public constant name = "Still Agents";
    string public constant symbol = "STILLAGENT";

    /// @notice USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.
    IUsdcV1 public immutable usdc;

    address public owner;
    address public pendingOwner;
    /// @notice Where every payment goes, at once.
    address public payee;
    /// @notice The price in wei; 0 closes minting with ETH.
    uint256 public priceWei;
    /// @notice The price in USDC's 6 decimals (500000 is 0.50 USDC); 0 closes minting with USDC.
    uint256 public priceUsdc;
    bool public mintOpen;
    /// @notice Agents held now.
    uint256 public totalSupply;

    string private baseUri;
    mapping(address => bool) private holds;
    uint256 private entered = 1;

    constructor(address usdc_, address payee_, uint256 priceWei_, uint256 priceUsdc_, string memory baseUri_) {
        if (usdc_ == address(0) || payee_ == address(0)) revert ZeroAddress();
        usdc = IUsdcV1(usdc_);
        owner = msg.sender;
        payee = payee_;
        priceWei = priceWei_;
        priceUsdc = priceUsdc_;
        baseUri = baseUri_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit PayeeSet(payee_);
        emit PricesSet(priceWei_, priceUsdc_);
        emit BaseUriSet(baseUri_);
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

    function balanceOf(address holder) external view returns (uint256) {
        if (holder == address(0)) revert ZeroAddress();
        return holds[holder] ? 1 : 0;
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address holder = address(uint160(tokenId));
        if (tokenId >> 160 != 0 || !holds[holder]) revert NoToken();
        return holder;
    }

    /// @notice A wallet's token id: the wallet itself.
    function tokenOf(address holder) external pure returns (uint256) {
        return uint256(uint160(holder));
    }

    /// @notice Still's page for the agent: `${baseUri}0x<wallet, lower case>`.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return string.concat(baseUri, _hex(ownerOf(tokenId)));
    }

    /// @notice The collection's own page, for marketplaces.
    function contractURI() external view returns (string memory) {
        return string.concat(baseUri, "collection");
    }

    /// @notice ERC-5192: every agent is bound to its wallet.
    function locked(uint256 tokenId) external view returns (bool) {
        ownerOf(tokenId);
        return true;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f // ERC-721 metadata
            || interfaceId == 0xb45a3c0e // ERC-5192
            || interfaceId == 0x49064906; // ERC-4906
    }

    // --- bound to the wallet: every way to move an agent refuses

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    // --- minting: one per wallet, paid at the price set now

    /// @notice Mints the caller's agent for exactly `priceWei`.
    function mint() external payable nonReentrant {
        uint256 price = priceWei;
        if (price == 0 || msg.value != price) revert WrongPayment();
        _mint(msg.sender, address(0), price);
        (bool paid,) = payee.call{value: price}("");
        if (!paid) revert PayFailed();
    }

    /// @notice Mints the caller's agent for `priceUsdc`, from an allowance the caller gave this contract.
    function mintWithUsdc() external nonReentrant {
        uint256 price = priceUsdc;
        if (price == 0) revert WrongPayment();
        _mint(msg.sender, address(usdc), price);
        if (!usdc.transferFrom(msg.sender, payee, price)) revert PayFailed();
    }

    /// @notice The same, with the allowance given by a permit signed for exactly `priceUsdc`, in one transaction.
    function mintWithUsdcPermit(uint256 deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        uint256 price = priceUsdc;
        if (price == 0) revert WrongPayment();
        // A permit someone else submitted first has already given the allowance: the transfer below is what counts.
        try usdc.permit(msg.sender, address(this), price, deadline, v, r, s) {} catch {}
        _mint(msg.sender, address(usdc), price);
        if (!usdc.transferFrom(msg.sender, payee, price)) revert PayFailed();
    }

    function _mint(address holder, address currency, uint256 paid) private {
        if (!mintOpen) revert MintClosed();
        if (holds[holder]) revert AlreadyMinted();
        holds[holder] = true;
        totalSupply += 1;
        uint256 tokenId = uint256(uint160(holder));
        emit Transfer(address(0), holder, tokenId);
        emit Locked(tokenId);
        emit Minted(holder, tokenId, currency, paid);
    }

    /// @notice The holder may let their agent go; the wallet can mint one again, paying again.
    function burn() external {
        if (!holds[msg.sender]) revert NoToken();
        holds[msg.sender] = false;
        totalSupply -= 1;
        emit Transfer(msg.sender, address(0), uint256(uint160(msg.sender)));
    }

    // --- the owner's settings

    function setPrices(uint256 priceWei_, uint256 priceUsdc_) external onlyOwner {
        priceWei = priceWei_;
        priceUsdc = priceUsdc_;
        emit PricesSet(priceWei_, priceUsdc_);
    }

    function setPayee(address payee_) external onlyOwner {
        if (payee_ == address(0)) revert ZeroAddress();
        payee = payee_;
        emit PayeeSet(payee_);
    }

    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
        emit MintOpenSet(open);
    }

    function setBaseUri(string calldata baseUri_) external onlyOwner {
        baseUri = baseUri_;
        emit BaseUriSet(baseUri_);
        emit BatchMetadataUpdate(0, type(uint160).max);
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

    function _hex(address who) private pure returns (string memory) {
        bytes memory digits = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint160 value = uint160(who);
        for (uint256 i = 41; i > 1; --i) {
            out[i] = digits[value & 0xf];
            value >>= 4;
        }
        return string(out);
    }
}
