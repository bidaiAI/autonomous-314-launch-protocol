// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {LaunchTokenBase} from "./LaunchTokenBase.sol";
import {ILaunchFactoryRegistry} from "./interfaces/ILaunchFactoryRegistry.sol";

contract LaunchTokenWhitelist is LaunchTokenBase {
    using Address for address payable;
    error UnauthorizedFactoryDeployment();

    uint256 public constant MAX_WHITELIST_DELAY = 3 days;
    uint256 public constant WHITELIST_DURATION = 24 hours;
    uint256 public constant MAX_SEATS = 80;
    uint256 public constant MAX_WHITELIST_MULTIPLE = 3;

    struct ConstructorArgs {
        string name;
        string symbol;
        string metadataURI;
        address creator;
        address factory;
        address protocolFeeRecipient;
        address router;
        uint256 graduationQuoteReserve;
        uint256 whitelistThreshold;
        uint256 whitelistSlotSize;
        uint256 whitelistOpensAt;
        address[] whitelistAddresses;
        uint8 launchModeId;
    }

    uint256 private immutable whitelistDeadline;
    uint256 private immutable whitelistThreshold;
    uint256 private immutable whitelistSlotSize;
    uint256 private immutable whitelistSeatCount;

    uint256 public whitelistSeatsFilled;
    uint256 public whitelistCommittedTotal;
    uint256 public whitelistCommitVault;
    uint256 public whitelistTokensPerSeat;
    bool public whitelistFinalized;
    bool public whitelistExpiredWithoutFinalization;

    mapping(address => bool) public whitelist;
    mapping(address => bool) public whitelistSeatCommitted;
    mapping(address => bool) public whitelistAllocationClaimed;
    mapping(address => bool) public whitelistRefundClaimed;

    event WhitelistConfigured(
        uint256 threshold,
        uint256 slotSize,
        uint256 seatCount,
        uint256 opensAt,
        uint256 deadline
    );
    event WhitelistSeatCommitted(address indexed account, uint256 seatNumber, uint256 amount, uint256 committedTotal);
    event WhitelistFinalized(uint256 grossCommitted, uint256 netQuoteAdded, uint256 protocolFee, uint256 creatorFee, uint256 seatsFilled, uint256 tokensPerSeat, uint256 reservedTokenAmount);
    event WhitelistExpired(uint256 committedTotal, uint256 seatsFilled);
    event WhitelistRefundClaimed(address indexed account, uint256 amount);
    event WhitelistAllocationClaimed(address indexed account, uint256 tokenAmount);

    error InvalidWhitelistThreshold();
    error InvalidWhitelistSlotSize();
    error InvalidWhitelistSeatCount();
    error InvalidWhitelistAddressCount();
    error InvalidWhitelistOpenTime();
    error DuplicateWhitelistAddress();
    error WhitelistNotActive();
    error WhitelistSeatUnavailable();
    error WhitelistAddressNotApproved();
    error InvalidWhitelistCommitAmount();
    error WhitelistAlreadyCommitted();
    error WhitelistRefundUnavailable();
    error WhitelistAllocationUnavailable();

    constructor(ConstructorArgs memory args) LaunchTokenBase(
        args.name,
        args.symbol,
        args.metadataURI,
        args.creator,
        args.factory,
        args.protocolFeeRecipient,
        args.router,
        args.graduationQuoteReserve,
        args.launchModeId,
        LaunchState.WhitelistCommit
    ) {
        if (!_isAllowedThreshold(args.factory, args.whitelistThreshold)) revert InvalidWhitelistThreshold();
        if (args.whitelistThreshold >= args.graduationQuoteReserve) revert InvalidWhitelistThreshold();
        if (!_isAllowedSlotSize(args.factory, args.whitelistSlotSize)) revert InvalidWhitelistSlotSize();
        if (args.whitelistThreshold % args.whitelistSlotSize != 0) revert InvalidWhitelistSeatCount();

        uint256 seatCount = args.whitelistThreshold / args.whitelistSlotSize;
        if (seatCount == 0 || seatCount > MAX_SEATS) revert InvalidWhitelistSeatCount();

        uint256 whitelistCount = args.whitelistAddresses.length;
        if (whitelistCount < seatCount || whitelistCount > seatCount * MAX_WHITELIST_MULTIPLE) {
            revert InvalidWhitelistAddressCount();
        }

        uint256 opensAt = args.whitelistOpensAt == 0 ? block.timestamp : args.whitelistOpensAt;
        if (opensAt < block.timestamp || opensAt > block.timestamp + MAX_WHITELIST_DELAY) revert InvalidWhitelistOpenTime();

        whitelistDeadline = opensAt + WHITELIST_DURATION;
        whitelistThreshold = args.whitelistThreshold;
        whitelistSlotSize = args.whitelistSlotSize;
        whitelistSeatCount = seatCount;

        for (uint256 i = 0; i < args.whitelistAddresses.length; i++) {
            address account = args.whitelistAddresses[i];
            if (account == address(0)) revert ZeroAddress();
            if (whitelist[account]) revert DuplicateWhitelistAddress();
            whitelist[account] = true;
        }

        emit WhitelistConfigured(
            args.whitelistThreshold,
            args.whitelistSlotSize,
            seatCount,
            opensAt,
            whitelistDeadline
        );
        if (!_isAuthorizedFactoryDeployment(args.factory)) revert UnauthorizedFactoryDeployment();
    }

    receive() external payable nonReentrant {
        _advanceWhitelistPhaseIfNeeded();

        if (state == LaunchState.WhitelistCommit) {
            _commitWhitelistSeat(msg.sender);
            return;
        }
        if (state == LaunchState.Bonding314) {
            _buyFrom(msg.sender, payable(msg.sender), 0);
            return;
        }

        revert InvalidState();
    }

    function launchSuffix() public view virtual override returns (string memory) {
        return "b314";
    }

    function commitWhitelistSeat() external payable nonReentrant {
        _advanceWhitelistPhaseIfNeeded();
        _commitWhitelistSeat(msg.sender);
    }

    function factoryCommitWhitelistSeat(address account) external payable nonReentrant {
        if (msg.sender != factory) revert UnauthorizedFactoryCaller();
        _advanceWhitelistPhaseIfNeeded();
        _commitWhitelistSeat(account);
    }

    function advanceWhitelistPhase() external {
        _advanceWhitelistPhaseIfNeeded();
    }

    function claimWhitelistAllocation() external nonReentrant returns (uint256 tokenAmount) {
        if (!whitelistFinalized || !whitelistSeatCommitted[msg.sender] || whitelistAllocationClaimed[msg.sender]) {
            revert WhitelistAllocationUnavailable();
        }

        tokenAmount = whitelistTokensPerSeat;
        whitelistAllocationClaimed[msg.sender] = true;
        whitelistAllocationTokenReserve -= tokenAmount;
        lastBuyBlock[msg.sender] = block.number;
        _transfer(address(this), msg.sender, tokenAmount);

        emit WhitelistAllocationClaimed(msg.sender, tokenAmount);
    }

    function claimWhitelistRefund() external nonReentrant returns (uint256 refundAmount) {
        _advanceWhitelistPhaseIfNeeded();
        if (!whitelistExpiredWithoutFinalization || !whitelistSeatCommitted[msg.sender] || whitelistRefundClaimed[msg.sender]) {
            revert WhitelistRefundUnavailable();
        }

        refundAmount = whitelistSlotSize;
        whitelistRefundClaimed[msg.sender] = true;
        whitelistCommitVault -= refundAmount;
        payable(msg.sender).sendValue(refundAmount);

        emit WhitelistRefundClaimed(msg.sender, refundAmount);
    }

    function whitelistStatus() public view override returns (uint8) {
        if (whitelistFinalized) return WHITELIST_STATUS_FINALIZED;
        if (state == LaunchState.WhitelistCommit) {
            if (block.timestamp + WHITELIST_DURATION < whitelistDeadline) return WHITELIST_STATUS_SCHEDULED;
            if (block.timestamp < whitelistDeadline) return WHITELIST_STATUS_ACTIVE;
            return WHITELIST_STATUS_EXPIRED;
        }
        if (whitelistExpiredWithoutFinalization || (state != LaunchState.WhitelistCommit && !whitelistFinalized)) {
            return WHITELIST_STATUS_EXPIRED;
        }
        return WHITELIST_STATUS_ACTIVE;
    }

    function whitelistSnapshot()
        external
        view
        override
        returns (
            uint8 status,
            uint256 opensAt,
            uint256 deadline,
            uint256 threshold,
            uint256 slotSize,
            uint256 seatCount,
            uint256 seatsFilled,
            uint256 committedTotal,
            uint256 tokensPerSeat
        )
    {
        return (
            whitelistStatus(),
            whitelistDeadline - WHITELIST_DURATION,
            whitelistDeadline,
            whitelistThreshold,
            whitelistSlotSize,
            whitelistSeatCount,
            whitelistSeatsFilled,
            whitelistCommittedTotal,
            whitelistTokensPerSeat
        );
    }

    function isWhitelisted(address account) public view override returns (bool) {
        return whitelist[account];
    }

    function canCommitWhitelist(address account) external view override returns (bool) {
        return state == LaunchState.WhitelistCommit
            && block.timestamp + WHITELIST_DURATION >= whitelistDeadline
            && block.timestamp < whitelistDeadline
            && whitelist[account]
            && !whitelistSeatCommitted[account]
            && whitelistSeatsFilled < whitelistSeatCount;
    }

    function canClaimWhitelistAllocation(address account) external view override returns (bool) {
        return whitelistFinalized && whitelistSeatCommitted[account] && !whitelistAllocationClaimed[account];
    }

    function canClaimWhitelistRefund(address account) external view override returns (bool) {
        bool expired = whitelistExpiredWithoutFinalization
            || (state == LaunchState.WhitelistCommit && block.timestamp >= whitelistDeadline && !whitelistFinalized);
        return expired && whitelistSeatCommitted[account] && !whitelistRefundClaimed[account];
    }

    function _beforeBondingAction() internal override {
        _advanceWhitelistPhaseIfNeeded();
    }

    function _additionalAccountedNative() internal view override returns (uint256) {
        return whitelistCommitVault;
    }

    function _commitWhitelistSeat(address account) internal {
        if (state != LaunchState.WhitelistCommit) revert WhitelistNotActive();
        if (block.timestamp + WHITELIST_DURATION < whitelistDeadline) revert WhitelistNotActive();
        if (block.timestamp >= whitelistDeadline) revert WhitelistNotActive();
        if (!whitelist[account]) revert WhitelistAddressNotApproved();
        if (msg.value != whitelistSlotSize) revert InvalidWhitelistCommitAmount();
        if (whitelistSeatCommitted[account]) revert WhitelistAlreadyCommitted();
        if (whitelistSeatsFilled >= whitelistSeatCount) revert WhitelistSeatUnavailable();

        whitelistSeatCommitted[account] = true;
        whitelistSeatsFilled += 1;
        whitelistCommittedTotal += msg.value;
        whitelistCommitVault += msg.value;

        emit WhitelistSeatCommitted(account, whitelistSeatsFilled, msg.value, whitelistCommittedTotal);

        if (whitelistCommittedTotal == whitelistThreshold) {
            _finalizeWhitelist();
        }
    }

    function _isAuthorizedFactoryDeployment(address factory_) private view returns (bool) {
        if (msg.sender == factory_) return true;
        if (factory_.code.length == 0) return false;
        ILaunchFactoryRegistry registry = ILaunchFactoryRegistry(factory_);
        if (launchModeId == MODE_WHITELIST_B314) {
            return msg.sender == registry.whitelistDeployer();
        }
        if (launchModeId == MODE_WHITELIST_TAX_F314) {
            return msg.sender == registry.whitelistTaxedDeployer();
        }
        return false;
    }

    function _advanceWhitelistPhaseIfNeeded() internal {
        if (state == LaunchState.WhitelistCommit && block.timestamp >= whitelistDeadline && !whitelistFinalized) {
            if (whitelistCommittedTotal >= whitelistThreshold) {
                _finalizeWhitelist();
            } else {
                whitelistExpiredWithoutFinalization = true;
                LaunchState previousState = state;
                state = LaunchState.Bonding314;
                emit StateTransition(previousState, LaunchState.Bonding314);
                emit WhitelistExpired(whitelistCommittedTotal, whitelistSeatsFilled);
            }
        }
    }

    function _finalizeWhitelist() internal {
        if (whitelistFinalized) revert InvalidState();
        if (whitelistCommittedTotal != whitelistThreshold) revert InvalidState();

        uint256 grossCommitted = whitelistCommittedTotal;
        (uint256 totalFee, uint256 protocolFee, uint256 creatorFee) = _splitFees(grossCommitted);
        uint256 netQuoteIn = grossCommitted - totalFee;
        if (netQuoteIn == 0) revert SlippageExceeded();

        uint256 totalTokenOut = _buyTokenOut(netQuoteIn);
        uint256 tokensPerSeat = totalTokenOut / whitelistSeatCount;
        uint256 reservedTokenAmount = tokensPerSeat * whitelistSeatCount;
        if (tokensPerSeat == 0 || reservedTokenAmount == 0 || reservedTokenAmount > saleTokenReserve) revert SlippageExceeded();

        whitelistFinalized = true;
        whitelistTokensPerSeat = tokensPerSeat;
        whitelistAllocationTokenReserve = reservedTokenAmount;
        whitelistCommitVault = 0;
        curveQuoteReserve += netQuoteIn;
        protocolFeeVault += protocolFee;
        creatorFeeVault += creatorFee;
        saleTokenReserve -= reservedTokenAmount;
        lastTradeAt = block.timestamp;

        LaunchState previousState = state;
        state = LaunchState.Bonding314;
        emit StateTransition(previousState, LaunchState.Bonding314);
        emit WhitelistFinalized(grossCommitted, netQuoteIn, protocolFee, creatorFee, whitelistSeatsFilled, tokensPerSeat, reservedTokenAmount);
    }

    function _isAllowedThreshold(address factory_, uint256 threshold) internal view returns (bool) {
        if (factory_.code.length == 0) return false;
        (bool success, bytes memory data) = factory_.staticcall(
            abi.encodeWithSelector(ILaunchFactoryRegistry.isAllowedWhitelistThreshold.selector, threshold)
        );
        return success && data.length >= 32 && abi.decode(data, (bool));
    }

    function _isAllowedSlotSize(address factory_, uint256 slotSize) internal view returns (bool) {
        if (factory_.code.length == 0) return false;
        (bool success, bytes memory data) = factory_.staticcall(
            abi.encodeWithSelector(ILaunchFactoryRegistry.isAllowedWhitelistSlotSize.selector, slotSize)
        );
        return success && data.length >= 32 && abi.decode(data, (bool));
    }
}
