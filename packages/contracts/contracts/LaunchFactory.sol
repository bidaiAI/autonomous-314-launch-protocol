// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {LaunchTokenDeployer} from "./LaunchTokenDeployer.sol";
import {LaunchTokenWhitelistDeployer} from "./LaunchTokenWhitelistDeployer.sol";

contract LaunchFactory is Ownable {
    using Address for address payable;

    enum LaunchMode {
        Unregistered,
        Standard0314,
        WhitelistB314
    }

    address public constant DEFAULT_PROTOCOL_FEE_RECIPIENT = 0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314;

    address public immutable router;
    address public immutable standardDeployer;
    address public immutable whitelistDeployer;
    uint256 public immutable graduationQuoteReserve;
    uint256 public immutable standardCreateFee;
    uint256 public immutable whitelistCreateFee;

    address public protocolFeeRecipient;
    uint256 public accruedProtocolCreateFees;

    address[] public allLaunches;
    mapping(address => address[]) public launchesByCreator;
    mapping(address => LaunchMode) public modeOf;

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

    constructor(
        address owner_,
        address router_,
        address protocolFeeRecipient_,
        address standardDeployer_,
        address whitelistDeployer_,
        uint256 standardCreateFee_,
        uint256 whitelistCreateFee_,
        uint256 graduationQuoteReserve_
    ) Ownable(owner_) {
        if (
            owner_ == address(0) || router_ == address(0) || standardDeployer_ == address(0)
                || whitelistDeployer_ == address(0)
        ) revert ZeroAddress();
        if (graduationQuoteReserve_ == 0) revert InvalidGraduationConfig();

        router = router_;
        standardDeployer = standardDeployer_;
        whitelistDeployer = whitelistDeployer_;
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
        if (mode == LaunchMode.Standard0314) return standardCreateFee;
        if (mode == LaunchMode.WhitelistB314) return whitelistCreateFee;
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



    function claimProtocolCreateFees() external returns (uint256 amount) {
        amount = _claimProtocolCreateFees(payable(protocolFeeRecipient));
    }

    function claimProtocolCreateFeesTo(address payable recipient) external returns (uint256 amount) {
        amount = _claimProtocolCreateFees(recipient);
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
        _collectCreateFee(standardCreateFee);
        LaunchTokenDeployer.DeployConfig memory config = LaunchTokenDeployer.DeployConfig({
            name: name_,
            symbol: symbol_,
            metadataURI: metadataURI_,
            creator: msg.sender,
            factory: address(this),
            protocolFeeRecipient: protocolFeeRecipient,
            router: router,
            graduationQuoteReserve: graduationQuoteReserve,
            salt: salt
        });
        token = LaunchTokenDeployer(standardDeployer).deploy(config);
        _registerLaunch(token, msg.sender, name_, symbol_, metadataURI_, LaunchMode.Standard0314);
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
        _collectCreateFee(whitelistCreateFee);
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
            salt: salt
        });
        token = LaunchTokenWhitelistDeployer(whitelistDeployer).deploy(config);
        _registerLaunch(token, msg.sender, name_, symbol_, metadataURI_, LaunchMode.WhitelistB314);
    }

    function _collectCreateFee(uint256 expectedFee) internal {
        if (msg.value < expectedFee) revert InsufficientCreateFee();
        if (expectedFee > 0) accruedProtocolCreateFees += expectedFee;

        uint256 refund = msg.value - expectedFee;
        if (refund > 0) {
            payable(msg.sender).sendValue(refund);
        }
    }

    function _registerLaunch(
        address token,
        address creator_,
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
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
}
