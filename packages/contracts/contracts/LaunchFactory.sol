// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {LaunchToken} from "./LaunchToken.sol";

contract LaunchFactory is Ownable {
    using Address for address payable;

    address public constant DEFAULT_PROTOCOL_FEE_RECIPIENT = 0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314;

    address public immutable router;
    uint256 public immutable graduationQuoteReserve;
    address public protocolFeeRecipient;
    uint256 public createFee;
    uint256 public accruedProtocolCreateFees;

    address[] public allLaunches;
    mapping(address => address[]) public launchesByCreator;

    event LaunchCreated(
        address indexed creator,
        address indexed token,
        string name,
        string symbol,
        string metadataURI
    );
    event ProtocolFeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event CreateFeeUpdated(uint256 previousFee, uint256 newFee);
    event ProtocolCreateFeesClaimed(address indexed recipient, uint256 amount);

    error InsufficientCreateFee();
    error ZeroAddress();
    error InvalidGraduationConfig();
    error NothingToClaim();
    error Unauthorized();

    constructor(
        address owner_,
        address router_,
        address protocolFeeRecipient_,
        uint256 createFee_,
        uint256 graduationQuoteReserve_
    ) Ownable(owner_) {
        if (owner_ == address(0) || router_ == address(0)) {
            revert ZeroAddress();
        }
        if (graduationQuoteReserve_ == 0) revert InvalidGraduationConfig();
        router = router_;
        graduationQuoteReserve = graduationQuoteReserve_;
        protocolFeeRecipient =
            protocolFeeRecipient_ == address(0) ? DEFAULT_PROTOCOL_FEE_RECIPIENT : protocolFeeRecipient_;
        createFee = createFee_;
    }

    function createLaunch(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_
    ) external payable returns (address token) {
        bytes32 salt = keccak256(abi.encode(msg.sender, allLaunches.length, block.chainid));
        token = _createLaunch(name_, symbol_, metadataURI_, salt);
    }

    function createLaunchWithSalt(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        bytes32 salt
    ) external payable returns (address token) {
        token = _createLaunch(name_, symbol_, metadataURI_, salt);
    }

    function predictLaunchAddress(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        address creator_,
        bytes32 salt
    ) external view returns (address predicted) {
        bytes memory bytecode = abi.encodePacked(
            type(LaunchToken).creationCode,
            abi.encode(name_, symbol_, metadataURI_, creator_, protocolFeeRecipient, router, graduationQuoteReserve)
        );
        predicted = Create2.computeAddress(salt, keccak256(bytecode));
    }

    function _createLaunch(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        bytes32 salt
    ) internal returns (address token) {
        if (msg.value < createFee) revert InsufficientCreateFee();

        LaunchToken launchToken = new LaunchToken{salt: salt}(
            name_,
            symbol_,
            metadataURI_,
            msg.sender,
            protocolFeeRecipient,
            router,
            graduationQuoteReserve
        );

        token = address(launchToken);
        allLaunches.push(token);
        launchesByCreator[msg.sender].push(token);

        if (createFee > 0) {
            accruedProtocolCreateFees += createFee;
        }

        uint256 refund = msg.value - createFee;
        if (refund > 0) {
            payable(msg.sender).sendValue(refund);
        }

        emit LaunchCreated(msg.sender, token, name_, symbol_, metadataURI_);
    }

    function claimProtocolCreateFees() external returns (uint256 amount) {
        if (msg.sender != protocolFeeRecipient) revert Unauthorized();
        amount = accruedProtocolCreateFees;
        if (amount == 0) revert NothingToClaim();

        accruedProtocolCreateFees = 0;
        payable(protocolFeeRecipient).sendValue(amount);

        emit ProtocolCreateFeesClaimed(protocolFeeRecipient, amount);
    }

    function totalLaunches() external view returns (uint256) {
        return allLaunches.length;
    }

    function launchesOf(address creator_) external view returns (address[] memory) {
        return launchesByCreator[creator_];
    }

    function setProtocolFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit ProtocolFeeRecipientUpdated(protocolFeeRecipient, newRecipient);
        protocolFeeRecipient = newRecipient;
    }

    function setCreateFee(uint256 newCreateFee) external onlyOwner {
        emit CreateFeeUpdated(createFee, newCreateFee);
        createFee = newCreateFee;
    }
}
