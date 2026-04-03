// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {LaunchTokenDeployer} from "./LaunchTokenDeployer.sol";
import {LaunchTokenWhitelistDeployer} from "./LaunchTokenWhitelistDeployer.sol";
import {LaunchTokenTaxedDeployer} from "./LaunchTokenTaxedDeployer.sol";
import {LaunchCreate2Deployer} from "./LaunchCreate2Deployer.sol";

contract LaunchFactory is Ownable {
    using Address for address payable;

    enum LaunchMode {
        Unregistered,
        Standard0314,
        WhitelistB314,
        Taxed1314,
        Taxed2314,
        Taxed3314,
        Taxed4314,
        Taxed5314,
        Taxed6314,
        Taxed7314,
        Taxed8314,
        Taxed9314,
        WhitelistTaxF314
    }

    address public constant DEFAULT_PROTOCOL_FEE_RECIPIENT = 0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314;

    address public immutable router;
    address public immutable standardDeployer;
    address public immutable whitelistDeployer;
    address public immutable taxedDeployer;
    address public immutable whitelistTaxedDeployer;
    uint256 public immutable graduationQuoteReserve;
    uint256 public immutable standardCreateFee;
    uint256 public immutable whitelistCreateFee;

    address public protocolFeeRecipient;
    uint256 public accruedProtocolCreateFees;

    address[] public allLaunches;
    mapping(address => address[]) public launchesByCreator;
    mapping(address => LaunchMode) public modeOf;
    mapping(address => LaunchMode) public pendingModeOf;

    event LaunchCreated(
        address indexed creator,
        address indexed token,
        uint8 indexed mode,
        string name,
        string symbol,
        string metadataURI
    );
    event ProtocolFeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event ProtocolCreateFeesClaimed(address indexed recipient, uint256 amount);

    error InsufficientCreateFee();
    error ZeroAddress();
    error InvalidGraduationConfig();
    error NothingToClaim();
    error PendingProtocolCreateFees();
    error Unauthorized();
    error MissingAtomicBuyValue();
    error InvalidWhitelistAtomicCommitAmount();
    error InvalidTaxMode();
    error InvalidTaxConfig();
    error UnknownLaunch();

    struct WhitelistTaxLaunchConfig {
        string name;
        string symbol;
        string metadataURI;
        uint256 whitelistThreshold;
        uint256 whitelistSlotSize;
        address[] whitelistAddresses;
        uint16 taxBps;
        uint16 burnShareBps;
        uint16 treasuryShareBps;
        address treasuryWallet;
        bytes initCode;
        bytes32 salt;
    }

    struct TaxConfigInput {
        uint16 taxBps;
        uint16 burnShareBps;
        uint16 treasuryShareBps;
        address treasuryWallet;
    }

    struct WhitelistConfigInput {
        uint256 whitelistThreshold;
        uint256 whitelistSlotSize;
        address[] whitelistAddresses;
    }

    constructor(
        address owner_,
        address router_,
        address protocolFeeRecipient_,
        address standardDeployer_,
        address whitelistDeployer_,
        address taxedDeployer_,
        address whitelistTaxedDeployer_,
        uint256 standardCreateFee_,
        uint256 whitelistCreateFee_,
        uint256 graduationQuoteReserve_
    ) Ownable(owner_) {
        if (
            owner_ == address(0) || router_ == address(0) || standardDeployer_ == address(0)
                || whitelistDeployer_ == address(0) || taxedDeployer_ == address(0)
                || whitelistTaxedDeployer_ == address(0)
        ) revert ZeroAddress();
        if (graduationQuoteReserve_ == 0) revert InvalidGraduationConfig();

        router = router_;
        standardDeployer = standardDeployer_;
        whitelistDeployer = whitelistDeployer_;
        taxedDeployer = taxedDeployer_;
        whitelistTaxedDeployer = whitelistTaxedDeployer_;
        protocolFeeRecipient =
            protocolFeeRecipient_ == address(0) ? DEFAULT_PROTOCOL_FEE_RECIPIENT : protocolFeeRecipient_;
        standardCreateFee = standardCreateFee_;
        whitelistCreateFee = whitelistCreateFee_;
        graduationQuoteReserve = graduationQuoteReserve_;
    }

    function createFee() external view returns (uint256) {
        return standardCreateFee;
    }

    function createFeeForMode(LaunchMode mode) public view returns (uint256) {
        if (mode == LaunchMode.Standard0314 || _isStandardTaxMode(mode)) return standardCreateFee;
        if (mode == LaunchMode.WhitelistB314 || mode == LaunchMode.WhitelistTaxF314) return whitelistCreateFee;
        return 0;
    }

    function createLaunch(string calldata name_, string calldata symbol_, string calldata metadataURI_)
        external
        payable
        returns (address token)
    {
        bytes32 salt = keccak256(abi.encode(msg.sender, launchesByCreator[msg.sender].length, block.chainid, uint8(1)));
        token = _createStandardLaunch(name_, symbol_, metadataURI_, salt);
    }

    function createLaunchWithSalt(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        bytes32 salt
    ) external payable returns (address token) {
        token = _createStandardLaunch(name_, symbol_, metadataURI_, salt);
    }

    function createLaunchAndBuy(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 minTokenOut
    ) external payable returns (address token, uint256 tokenOut) {
        bytes32 salt = keccak256(abi.encode(msg.sender, launchesByCreator[msg.sender].length, block.chainid, uint8(1)));
        (token, tokenOut) = _createStandardLaunchAndBuy(name_, symbol_, metadataURI_, salt, minTokenOut);
    }

    function createLaunchAndBuyWithSalt(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        bytes32 salt,
        uint256 minTokenOut
    ) external payable returns (address token, uint256 tokenOut) {
        (token, tokenOut) = _createStandardLaunchAndBuy(name_, symbol_, metadataURI_, salt, minTokenOut);
    }

    function createWhitelistLaunch(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 whitelistThreshold,
        uint256 whitelistSlotSize,
        address[] calldata whitelistAddresses
    ) external payable returns (address token) {
        bytes32 salt = keccak256(
            abi.encode(
                msg.sender,
                launchesByCreator[msg.sender].length,
                block.chainid,
                uint8(2),
                whitelistThreshold,
                whitelistSlotSize
            )
        );
        token = _createWhitelistLaunch(name_, symbol_, metadataURI_, whitelistThreshold, whitelistSlotSize, whitelistAddresses, salt);
    }

    function createWhitelistLaunchWithSalt(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 whitelistThreshold,
        uint256 whitelistSlotSize,
        address[] calldata whitelistAddresses,
        bytes32 salt
    ) external payable returns (address token) {
        token = _createWhitelistLaunch(name_, symbol_, metadataURI_, whitelistThreshold, whitelistSlotSize, whitelistAddresses, salt);
    }

    function createWhitelistLaunchAndCommit(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 whitelistThreshold,
        uint256 whitelistSlotSize,
        address[] calldata whitelistAddresses
    ) external payable returns (address token) {
        bytes32 salt = keccak256(
            abi.encode(
                msg.sender,
                launchesByCreator[msg.sender].length,
                block.chainid,
                uint8(2),
                whitelistThreshold,
                whitelistSlotSize
            )
        );
        token = _createWhitelistLaunchAndCommit(
            name_,
            symbol_,
            metadataURI_,
            whitelistThreshold,
            whitelistSlotSize,
            whitelistAddresses,
            salt
        );
    }

    function createWhitelistLaunchAndCommitWithSalt(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 whitelistThreshold,
        uint256 whitelistSlotSize,
        address[] calldata whitelistAddresses,
        bytes32 salt
    ) external payable returns (address token) {
        token = _createWhitelistLaunchAndCommit(
            name_,
            symbol_,
            metadataURI_,
            whitelistThreshold,
            whitelistSlotSize,
            whitelistAddresses,
            salt
        );
    }

    function createTaxLaunch(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint16 taxBps,
        uint16 burnShareBps,
        uint16 treasuryShareBps,
        address treasuryWallet
    ) external payable returns (address token) {
        bytes32 salt = keccak256(
            abi.encode(msg.sender, launchesByCreator[msg.sender].length, block.chainid, uint8(3), taxBps)
        );
        token = _createTaxLaunch(name_, symbol_, metadataURI_, taxBps, burnShareBps, treasuryShareBps, treasuryWallet, salt);
    }

    function createTaxLaunchWithSalt(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint16 taxBps,
        uint16 burnShareBps,
        uint16 treasuryShareBps,
        address treasuryWallet,
        bytes32 salt
    ) external payable returns (address token) {
        token = _createTaxLaunch(name_, symbol_, metadataURI_, taxBps, burnShareBps, treasuryShareBps, treasuryWallet, salt);
    }

    function createTaxLaunchAndBuy(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint16 taxBps,
        uint16 burnShareBps,
        uint16 treasuryShareBps,
        address treasuryWallet,
        uint256 minTokenOut
    ) external payable returns (address token, uint256 tokenOut) {
        bytes32 salt = keccak256(
            abi.encode(msg.sender, launchesByCreator[msg.sender].length, block.chainid, uint8(3), taxBps)
        );
        (token, tokenOut) = _createTaxLaunchAndBuy(
            name_, symbol_, metadataURI_, taxBps, burnShareBps, treasuryShareBps, treasuryWallet, salt, minTokenOut
        );
    }

    function createTaxLaunchAndBuyWithSalt(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint16 taxBps,
        uint16 burnShareBps,
        uint16 treasuryShareBps,
        address treasuryWallet,
        bytes32 salt,
        uint256 minTokenOut
    ) external payable returns (address token, uint256 tokenOut) {
        (token, tokenOut) = _createTaxLaunchAndBuy(
            name_, symbol_, metadataURI_, taxBps, burnShareBps, treasuryShareBps, treasuryWallet, salt, minTokenOut
        );
    }

    function createWhitelistTaxLaunch(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        WhitelistConfigInput calldata whitelistConfig,
        TaxConfigInput calldata taxConfig,
        bytes calldata initCode
    ) external payable returns (address token) {
        bytes32 salt = keccak256(
            abi.encode(
                msg.sender,
                launchesByCreator[msg.sender].length,
                block.chainid,
                uint8(4),
                whitelistConfig.whitelistThreshold,
                whitelistConfig.whitelistSlotSize,
                taxConfig.taxBps
            )
        );
        token = _createWhitelistTaxLaunch(
            WhitelistTaxLaunchConfig({
                name: name_,
                symbol: symbol_,
                metadataURI: metadataURI_,
                whitelistThreshold: whitelistConfig.whitelistThreshold,
                whitelistSlotSize: whitelistConfig.whitelistSlotSize,
                whitelistAddresses: whitelistConfig.whitelistAddresses,
                taxBps: taxConfig.taxBps,
                burnShareBps: taxConfig.burnShareBps,
                treasuryShareBps: taxConfig.treasuryShareBps,
                treasuryWallet: taxConfig.treasuryWallet,
                initCode: initCode,
                salt: salt
            })
        );
    }

    function createWhitelistTaxLaunchWithSalt(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        WhitelistConfigInput calldata whitelistConfig,
        TaxConfigInput calldata taxConfig,
        bytes calldata initCode,
        bytes32 salt
    ) external payable returns (address token) {
        token = _createWhitelistTaxLaunch(
            WhitelistTaxLaunchConfig({
                name: name_,
                symbol: symbol_,
                metadataURI: metadataURI_,
                whitelistThreshold: whitelistConfig.whitelistThreshold,
                whitelistSlotSize: whitelistConfig.whitelistSlotSize,
                whitelistAddresses: whitelistConfig.whitelistAddresses,
                taxBps: taxConfig.taxBps,
                burnShareBps: taxConfig.burnShareBps,
                treasuryShareBps: taxConfig.treasuryShareBps,
                treasuryWallet: taxConfig.treasuryWallet,
                initCode: initCode,
                salt: salt
            })
        );
    }

    function createWhitelistTaxLaunchAndCommit(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        WhitelistConfigInput calldata whitelistConfig,
        TaxConfigInput calldata taxConfig,
        bytes calldata initCode
    ) external payable returns (address token) {
        bytes32 salt = keccak256(
            abi.encode(
                msg.sender,
                launchesByCreator[msg.sender].length,
                block.chainid,
                uint8(4),
                whitelistConfig.whitelistThreshold,
                whitelistConfig.whitelistSlotSize,
                taxConfig.taxBps
            )
        );
        token = _createWhitelistTaxLaunchAndCommit(
            WhitelistTaxLaunchConfig({
                name: name_,
                symbol: symbol_,
                metadataURI: metadataURI_,
                whitelistThreshold: whitelistConfig.whitelistThreshold,
                whitelistSlotSize: whitelistConfig.whitelistSlotSize,
                whitelistAddresses: whitelistConfig.whitelistAddresses,
                taxBps: taxConfig.taxBps,
                burnShareBps: taxConfig.burnShareBps,
                treasuryShareBps: taxConfig.treasuryShareBps,
                treasuryWallet: taxConfig.treasuryWallet,
                initCode: initCode,
                salt: salt
            })
        );
    }

    function createWhitelistTaxLaunchAndCommitWithSalt(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        WhitelistConfigInput calldata whitelistConfig,
        TaxConfigInput calldata taxConfig,
        bytes calldata initCode,
        bytes32 salt
    ) external payable returns (address token) {
        token = _createWhitelistTaxLaunchAndCommit(
            WhitelistTaxLaunchConfig({
                name: name_,
                symbol: symbol_,
                metadataURI: metadataURI_,
                whitelistThreshold: whitelistConfig.whitelistThreshold,
                whitelistSlotSize: whitelistConfig.whitelistSlotSize,
                whitelistAddresses: whitelistConfig.whitelistAddresses,
                taxBps: taxConfig.taxBps,
                burnShareBps: taxConfig.burnShareBps,
                treasuryShareBps: taxConfig.treasuryShareBps,
                treasuryWallet: taxConfig.treasuryWallet,
                initCode: initCode,
                salt: salt
            })
        );
    }

    function claimProtocolCreateFees() external returns (uint256 amount) {
        amount = _claimProtocolCreateFees(payable(protocolFeeRecipient));
    }

    function claimProtocolCreateFeesTo(address payable recipient) external returns (uint256 amount) {
        amount = _claimProtocolCreateFees(recipient);
    }

    function batchClaimProtocolFees(address[] calldata tokens, address payable recipient)
        external
        returns (uint256 totalClaimed, uint256 claimedCount)
    {
        if (msg.sender != protocolFeeRecipient) revert Unauthorized();
        if (recipient == address(0)) revert ZeroAddress();

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (modeOf[token] == LaunchMode.Unregistered) revert UnknownLaunch();
            uint256 claimable = ILaunchTokenProtocolOps(token).protocolClaimable();
            if (claimable == 0) continue;
            totalClaimed += ILaunchTokenProtocolOps(token).factoryClaimProtocolFeesTo(recipient);
            claimedCount += 1;
        }
    }

    function batchSweepAbandonedCreatorFees(address[] calldata tokens)
        external
        returns (uint256 totalSwept, uint256 sweptCount)
    {
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (modeOf[token] == LaunchMode.Unregistered) revert UnknownLaunch();
            if (!ILaunchTokenProtocolOps(token).creatorFeeSweepReady()) continue;
            totalSwept += ILaunchTokenProtocolOps(token).sweepAbandonedCreatorFees();
            sweptCount += 1;
        }
    }

    function totalLaunches() external view returns (uint256) {
        return allLaunches.length;
    }

    function launchesOf(address creator_) external view returns (address[] memory) {
        return launchesByCreator[creator_];
    }

    function setProtocolFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        if (accruedProtocolCreateFees != 0) revert PendingProtocolCreateFees();
        emit ProtocolFeeRecipientUpdated(protocolFeeRecipient, newRecipient);
        protocolFeeRecipient = newRecipient;
    }

    function _createStandardLaunch(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        bytes32 salt
    ) internal returns (address token) {
        uint256 remainder = _collectCreateFee(standardCreateFee);
        if (remainder > 0) {
            payable(msg.sender).sendValue(remainder);
        }
        LaunchTokenDeployer.DeployConfig memory config = LaunchTokenDeployer.DeployConfig({
            name: name_,
            symbol: symbol_,
            metadataURI: metadataURI_,
            creator: msg.sender,
            factory: address(this),
            protocolFeeRecipient: protocolFeeRecipient,
            router: router,
            graduationQuoteReserve: graduationQuoteReserve,
            launchModeId: 1,
            salt: salt
        });
        token = LaunchTokenDeployer(standardDeployer).deploy(config);
        _registerLaunch(token, msg.sender, name_, symbol_, metadataURI_, LaunchMode.Standard0314);
    }

    function _createStandardLaunchAndBuy(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        bytes32 salt,
        uint256 minTokenOut
    ) internal returns (address token, uint256 tokenOut) {
        uint256 buyValue = _collectCreateFee(standardCreateFee);
        if (buyValue == 0) revert MissingAtomicBuyValue();

        LaunchTokenDeployer.DeployConfig memory config = LaunchTokenDeployer.DeployConfig({
            name: name_,
            symbol: symbol_,
            metadataURI: metadataURI_,
            creator: msg.sender,
            factory: address(this),
            protocolFeeRecipient: protocolFeeRecipient,
            router: router,
            graduationQuoteReserve: graduationQuoteReserve,
            launchModeId: 1,
            salt: salt
        });
        token = LaunchTokenDeployer(standardDeployer).deploy(config);
        _registerLaunch(token, msg.sender, name_, symbol_, metadataURI_, LaunchMode.Standard0314);
        tokenOut = ILaunchTokenFactoryActions(token).factoryBuyFor{value: buyValue}(msg.sender, minTokenOut);
    }

    function _createWhitelistLaunch(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 whitelistThreshold,
        uint256 whitelistSlotSize,
        address[] calldata whitelistAddresses,
        bytes32 salt
    ) internal returns (address token) {
        uint256 remainder = _collectCreateFee(whitelistCreateFee);
        if (remainder > 0) {
            payable(msg.sender).sendValue(remainder);
        }
        LaunchTokenWhitelistDeployer.DeployConfig memory config = LaunchTokenWhitelistDeployer.DeployConfig({
            name: name_,
            symbol: symbol_,
            metadataURI: metadataURI_,
            creator: msg.sender,
            factory: address(this),
            protocolFeeRecipient: protocolFeeRecipient,
            router: router,
            graduationQuoteReserve: graduationQuoteReserve,
            whitelistThreshold: whitelistThreshold,
            whitelistSlotSize: whitelistSlotSize,
            whitelistAddresses: whitelistAddresses,
            launchModeId: 2,
            salt: salt
        });
        token = LaunchTokenWhitelistDeployer(whitelistDeployer).deploy(config);
        _registerLaunch(token, msg.sender, name_, symbol_, metadataURI_, LaunchMode.WhitelistB314);
    }

    function _createWhitelistLaunchAndCommit(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 whitelistThreshold,
        uint256 whitelistSlotSize,
        address[] calldata whitelistAddresses,
        bytes32 salt
    ) internal returns (address token) {
        uint256 commitValue = _collectCreateFee(whitelistCreateFee);
        if (commitValue != whitelistSlotSize) revert InvalidWhitelistAtomicCommitAmount();

        LaunchTokenWhitelistDeployer.DeployConfig memory config = LaunchTokenWhitelistDeployer.DeployConfig({
            name: name_,
            symbol: symbol_,
            metadataURI: metadataURI_,
            creator: msg.sender,
            factory: address(this),
            protocolFeeRecipient: protocolFeeRecipient,
            router: router,
            graduationQuoteReserve: graduationQuoteReserve,
            whitelistThreshold: whitelistThreshold,
            whitelistSlotSize: whitelistSlotSize,
            whitelistAddresses: whitelistAddresses,
            launchModeId: 2,
            salt: salt
        });
        token = LaunchTokenWhitelistDeployer(whitelistDeployer).deploy(config);
        _registerLaunch(token, msg.sender, name_, symbol_, metadataURI_, LaunchMode.WhitelistB314);
        ILaunchTokenWhitelistFactoryActions(token).factoryCommitWhitelistSeat{value: commitValue}(msg.sender);
    }

    function _createTaxLaunch(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint16 taxBps,
        uint16 burnShareBps,
        uint16 treasuryShareBps,
        address treasuryWallet,
        bytes32 salt
    ) internal returns (address token) {
        LaunchMode mode = _standardTaxModeFor(taxBps);
        _validateTaxConfig(taxBps, burnShareBps, treasuryShareBps, treasuryWallet);
        uint256 remainder = _collectCreateFee(standardCreateFee);
        if (remainder > 0) {
            payable(msg.sender).sendValue(remainder);
        }
        LaunchTokenTaxedDeployer.DeployConfig memory config = LaunchTokenTaxedDeployer.DeployConfig({
            name: name_,
            symbol: symbol_,
            metadataURI: metadataURI_,
            creator: msg.sender,
            factory: address(this),
            protocolFeeRecipient: protocolFeeRecipient,
            router: router,
            graduationQuoteReserve: graduationQuoteReserve,
            launchModeId: uint8(mode),
            taxBps: taxBps,
            burnShareBps: burnShareBps,
            treasuryShareBps: treasuryShareBps,
            treasuryWallet: treasuryWallet,
            salt: salt
        });
        token = LaunchTokenTaxedDeployer(taxedDeployer).deploy(config);
        _registerLaunch(token, msg.sender, name_, symbol_, metadataURI_, mode);
    }

    function _createTaxLaunchAndBuy(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint16 taxBps,
        uint16 burnShareBps,
        uint16 treasuryShareBps,
        address treasuryWallet,
        bytes32 salt,
        uint256 minTokenOut
    ) internal returns (address token, uint256 tokenOut) {
        LaunchMode mode = _standardTaxModeFor(taxBps);
        _validateTaxConfig(taxBps, burnShareBps, treasuryShareBps, treasuryWallet);
        uint256 buyValue = _collectCreateFee(standardCreateFee);
        if (buyValue == 0) revert MissingAtomicBuyValue();

        LaunchTokenTaxedDeployer.DeployConfig memory config = LaunchTokenTaxedDeployer.DeployConfig({
            name: name_,
            symbol: symbol_,
            metadataURI: metadataURI_,
            creator: msg.sender,
            factory: address(this),
            protocolFeeRecipient: protocolFeeRecipient,
            router: router,
            graduationQuoteReserve: graduationQuoteReserve,
            launchModeId: uint8(mode),
            taxBps: taxBps,
            burnShareBps: burnShareBps,
            treasuryShareBps: treasuryShareBps,
            treasuryWallet: treasuryWallet,
            salt: salt
        });
        token = LaunchTokenTaxedDeployer(taxedDeployer).deploy(config);
        _registerLaunch(token, msg.sender, name_, symbol_, metadataURI_, mode);
        tokenOut = ILaunchTokenFactoryActions(token).factoryBuyFor{value: buyValue}(msg.sender, minTokenOut);
    }

    function _createWhitelistTaxLaunch(WhitelistTaxLaunchConfig memory config)
        internal
        returns (address token)
    {
        _validateTaxConfig(config.taxBps, config.burnShareBps, config.treasuryShareBps, config.treasuryWallet);
        uint256 remainder = _collectCreateFee(whitelistCreateFee);
        if (remainder > 0) {
            payable(msg.sender).sendValue(remainder);
        }
        token = _deployWhitelistTaxed(config);
        _registerLaunch(token, msg.sender, config.name, config.symbol, config.metadataURI, LaunchMode.WhitelistTaxF314);
    }

    function _createWhitelistTaxLaunchAndCommit(WhitelistTaxLaunchConfig memory config)
        internal
        returns (address token)
    {
        _validateTaxConfig(config.taxBps, config.burnShareBps, config.treasuryShareBps, config.treasuryWallet);
        uint256 commitValue = _collectCreateFee(whitelistCreateFee);
        if (commitValue != config.whitelistSlotSize) revert InvalidWhitelistAtomicCommitAmount();

        token = _deployWhitelistTaxed(config);
        _registerLaunch(token, msg.sender, config.name, config.symbol, config.metadataURI, LaunchMode.WhitelistTaxF314);
        ILaunchTokenWhitelistFactoryActions(token).factoryCommitWhitelistSeat{value: commitValue}(msg.sender);
    }

    function _deployWhitelistTaxed(WhitelistTaxLaunchConfig memory config)
        internal
        returns (address token)
    {
        if (config.initCode.length == 0) revert InvalidTaxConfig();

        token = LaunchCreate2Deployer(whitelistTaxedDeployer).predict(config.salt, keccak256(config.initCode));
        pendingModeOf[token] = LaunchMode.WhitelistTaxF314;
        token = LaunchCreate2Deployer(whitelistTaxedDeployer).deploy(config.salt, config.initCode);
        if (modeOf[token] != LaunchMode.Unregistered || pendingModeOf[token] != LaunchMode.WhitelistTaxF314) revert InvalidTaxConfig();
        pendingModeOf[token] = LaunchMode.Unregistered;

        ILaunchTokenWhitelistInspection launch = ILaunchTokenWhitelistInspection(token);
        if (
            launch.creator() != msg.sender || launch.factory() != address(this)
                || launch.protocolFeeRecipient() != protocolFeeRecipient || launch.router() != router
                || launch.graduationQuoteReserve() != graduationQuoteReserve
                || launch.launchMode() != uint8(LaunchMode.WhitelistTaxF314)
                || keccak256(bytes(launch.name())) != keccak256(bytes(config.name))
                || keccak256(bytes(launch.symbol())) != keccak256(bytes(config.symbol))
                || keccak256(bytes(launch.metadataURI())) != keccak256(bytes(config.metadataURI))
        ) revert InvalidTaxConfig();

        (, , uint256 threshold, uint256 slotSize,,,,, uint256 configuredWhitelistCount) = launch.whitelistSnapshot();
        if (
            threshold != config.whitelistThreshold || slotSize != config.whitelistSlotSize
                || configuredWhitelistCount != config.whitelistAddresses.length
        ) revert InvalidTaxConfig();
        for (uint256 i = 0; i < config.whitelistAddresses.length; i++) {
            if (!launch.isWhitelisted(config.whitelistAddresses[i])) revert InvalidTaxConfig();
        }

        (bool enabled, uint16 configuredTaxBps, uint16 burnBps, uint16 treasuryBps, address wallet,) = launch.taxConfig();
        if (
            !enabled || configuredTaxBps != config.taxBps || burnBps != config.burnShareBps
                || treasuryBps != config.treasuryShareBps || wallet != config.treasuryWallet
        ) revert InvalidTaxConfig();
    }

    function _collectCreateFee(uint256 expectedFee) internal returns (uint256 remainder) {
        if (msg.value < expectedFee) revert InsufficientCreateFee();
        if (expectedFee > 0) accruedProtocolCreateFees += expectedFee;
        remainder = msg.value - expectedFee;
    }

    function _registerLaunch(
        address token,
        address creator_,
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        LaunchMode mode
    ) internal {
        allLaunches.push(token);
        launchesByCreator[creator_].push(token);
        modeOf[token] = mode;
        emit LaunchCreated(creator_, token, uint8(mode), name_, symbol_, metadataURI_);
    }

    function _claimProtocolCreateFees(address payable recipient) internal returns (uint256 amount) {
        if (msg.sender != protocolFeeRecipient) revert Unauthorized();
        if (recipient == address(0)) revert ZeroAddress();
        amount = accruedProtocolCreateFees;
        if (amount == 0) revert NothingToClaim();

        accruedProtocolCreateFees = 0;
        recipient.sendValue(amount);

        emit ProtocolCreateFeesClaimed(recipient, amount);
    }

    function _standardTaxModeFor(uint16 taxBps) internal pure returns (LaunchMode) {
        if (taxBps == 100) return LaunchMode.Taxed1314;
        if (taxBps == 200) return LaunchMode.Taxed2314;
        if (taxBps == 300) return LaunchMode.Taxed3314;
        if (taxBps == 400) return LaunchMode.Taxed4314;
        if (taxBps == 500) return LaunchMode.Taxed5314;
        if (taxBps == 600) return LaunchMode.Taxed6314;
        if (taxBps == 700) return LaunchMode.Taxed7314;
        if (taxBps == 800) return LaunchMode.Taxed8314;
        if (taxBps == 900) return LaunchMode.Taxed9314;
        revert InvalidTaxMode();
    }

    function _isStandardTaxMode(LaunchMode mode) internal pure returns (bool) {
        return mode >= LaunchMode.Taxed1314 && mode <= LaunchMode.Taxed9314;
    }

    function _validateTaxConfig(
        uint16 taxBps,
        uint16 burnShareBps,
        uint16 treasuryShareBps,
        address treasuryWallet
    ) internal pure {
        _standardTaxModeFor(taxBps);
        if (burnShareBps + treasuryShareBps != 10_000) revert InvalidTaxConfig();
        if (treasuryShareBps > 0 && treasuryWallet == address(0)) revert InvalidTaxConfig();
        if (treasuryShareBps == 0 && treasuryWallet != address(0)) revert InvalidTaxConfig();
    }
}

interface ILaunchTokenFactoryActions {
    function factoryBuyFor(address recipient, uint256 minTokenOut) external payable returns (uint256 tokenOut);
}

interface ILaunchTokenWhitelistFactoryActions {
    function factoryCommitWhitelistSeat(address account) external payable;
}

interface ILaunchTokenProtocolOps {
    function protocolClaimable() external view returns (uint256);
    function creatorFeeSweepReady() external view returns (bool);
    function factoryClaimProtocolFeesTo(address payable recipient) external returns (uint256 amount);
    function sweepAbandonedCreatorFees() external returns (uint256 amount);
}

interface ILaunchTokenWhitelistInspection {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function metadataURI() external view returns (string memory);
    function creator() external view returns (address);
    function factory() external view returns (address);
    function protocolFeeRecipient() external view returns (address);
    function router() external view returns (address);
    function graduationQuoteReserve() external view returns (uint256);
    function launchMode() external view returns (uint8);
    function isWhitelisted(address account) external view returns (bool);
    function whitelistSnapshot()
        external
        view
        returns (
            uint8 status,
            uint256 deadline,
            uint256 threshold,
            uint256 slotSize,
            uint256 seatCount,
            uint256 seatsFilled,
            uint256 committedTotal,
            uint256 tokensPerSeat,
            uint256 configuredWhitelistCount
        );
    function taxConfig()
        external
        view
        returns (bool enabled, uint16 taxBps, uint16 burnShareBps, uint16 treasuryShareBps, address treasuryWallet, bool active);
}
