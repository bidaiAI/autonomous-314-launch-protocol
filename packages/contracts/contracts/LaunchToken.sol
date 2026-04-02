// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IUniswapV2LikeFactory} from "./interfaces/IUniswapV2LikeFactory.sol";
import {IUniswapV2LikePair} from "./interfaces/IUniswapV2LikePair.sol";
import {IUniswapV2LikeRouter02} from "./interfaces/IUniswapV2LikeRouter02.sol";

contract LaunchToken is ERC20, ReentrancyGuard {
    using Address for address payable;

    enum LaunchState {
        Created,
        Bonding314,
        Migrating,
        DEXOnly
    }

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant LP_TOKEN_RESERVE = 200_000_000 ether;
    uint256 public constant SALE_TOKEN_RESERVE = TOTAL_SUPPLY - LP_TOKEN_RESERVE;
    uint256 public constant VIRTUAL_QUOTE_DIVISOR = 3;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant TOTAL_FEE_BPS = 100;
    uint256 public constant PROTOCOL_FEE_BPS = 50;
    uint256 public constant CREATOR_FEE_BPS = 50;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address public immutable creator;
    address public immutable factory;
    address public immutable protocolFeeRecipient;
    address public immutable router;
    address public immutable dexFactory;
    address public immutable wrappedNative;
    uint256 public immutable graduationQuoteReserve;
    uint256 public immutable virtualQuoteReserve;
    uint256 public immutable virtualTokenReserve;
    string public metadataURI;

    LaunchState public state;
    address public pair;

    uint256 public saleTokenReserve;
    uint256 public lpTokenReserve;
    uint256 public curveQuoteReserve;
    uint256 public protocolFeeVault;
    uint256 public creatorFeeVault;

    mapping(address => uint256) public lastBuyBlock;

    event StateTransition(LaunchState indexed previousState, LaunchState indexed newState);
    event BuyExecuted(
        address indexed buyer,
        uint256 grossQuoteIn,
        uint256 netQuoteIn,
        uint256 protocolFee,
        uint256 creatorFee,
        uint256 refundAmount,
        uint256 tokenOut,
        uint256 newCurveQuoteReserve,
        uint256 newSaleTokenReserve
    );
    event SellExecuted(
        address indexed seller,
        uint256 tokenIn,
        uint256 grossQuoteOut,
        uint256 netQuoteOut,
        uint256 protocolFee,
        uint256 creatorFee,
        uint256 newCurveQuoteReserve,
        uint256 newSaleTokenReserve
    );
    event Graduated(
        address indexed pair,
        uint256 tokenAmount,
        uint256 quoteAmountContributed,
        uint256 preloadedQuoteAmount,
        uint256 liquidityBurned
    );
    event ProtocolFeesClaimed(address indexed recipient, uint256 amount);
    event CreatorFeesClaimed(address indexed recipient, uint256 amount);

    error InvalidState();
    error ZeroAmount();
    error TransferDisabledPreGraduation();
    error SellCooldownActive();
    error SlippageExceeded();
    error GraduationAlreadyTriggered();
    error PairPolluted();
    error NothingToClaim();
    error Unauthorized();
    error InvalidRecipient();
    error WrappedQuoteTransferFailed();
    error InvalidGraduationConfig();

    modifier inState(LaunchState expected) {
        if (state != expected) revert InvalidState();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        address creator_,
        address protocolFeeRecipient_,
        address router_,
        uint256 graduationQuoteReserve_
    ) ERC20(name_, symbol_) {
        if (graduationQuoteReserve_ == 0) revert InvalidGraduationConfig();
        uint256 virtualQuoteReserve_ = graduationQuoteReserve_ / VIRTUAL_QUOTE_DIVISOR;
        if (virtualQuoteReserve_ == 0) revert InvalidGraduationConfig();

        creator = creator_;
        factory = msg.sender;
        protocolFeeRecipient = protocolFeeRecipient_;
        router = router_;
        dexFactory = IUniswapV2LikeRouter02(router_).factory();
        wrappedNative = IUniswapV2LikeRouter02(router_).WETH();
        graduationQuoteReserve = graduationQuoteReserve_;
        virtualQuoteReserve = virtualQuoteReserve_;
        virtualTokenReserve = (LP_TOKEN_RESERVE * virtualQuoteReserve_) / graduationQuoteReserve_;
        metadataURI = metadataURI_;

        _mint(address(this), TOTAL_SUPPLY);
        saleTokenReserve = SALE_TOKEN_RESERVE;
        lpTokenReserve = LP_TOKEN_RESERVE;

        pair = _ensurePair();
        state = LaunchState.Bonding314;
        emit StateTransition(LaunchState.Created, LaunchState.Bonding314);
    }

    receive() external payable nonReentrant {
        if (state == LaunchState.Bonding314) {
            _buy(msg.sender, 0);
            return;
        }

        if (msg.sender == router || msg.sender == wrappedNative) {
            return;
        }

        revert InvalidState();
    }

    function buy(uint256 minTokenOut) external payable nonReentrant inState(LaunchState.Bonding314) returns (uint256 tokenOut) {
        tokenOut = _buy(msg.sender, minTokenOut);
    }

    function sell(uint256 tokenAmount, uint256 minQuoteOut)
        external
        nonReentrant
        inState(LaunchState.Bonding314)
        returns (uint256 netQuoteOut)
    {
        if (tokenAmount == 0) revert ZeroAmount();
        if (lastBuyBlock[msg.sender] == block.number) revert SellCooldownActive();

        (uint256 effectiveQuoteReserve, uint256 effectiveTokenReserve) = _effectiveReserves();
        uint256 invariant = effectiveQuoteReserve * effectiveTokenReserve;
        uint256 newEffectiveTokenReserve = effectiveTokenReserve + tokenAmount;
        uint256 newEffectiveQuoteReserve = Math.ceilDiv(invariant, newEffectiveTokenReserve);
        uint256 grossQuoteOut = effectiveQuoteReserve - newEffectiveQuoteReserve;

        if (grossQuoteOut == 0 || grossQuoteOut > curveQuoteReserve) revert SlippageExceeded();

        (uint256 totalFee, uint256 protocolFee, uint256 creatorFee) = _splitFees(grossQuoteOut);
        netQuoteOut = grossQuoteOut - totalFee;
        if (netQuoteOut < minQuoteOut) revert SlippageExceeded();

        _transfer(msg.sender, address(this), tokenAmount);

        saleTokenReserve += tokenAmount;
        curveQuoteReserve -= grossQuoteOut;
        protocolFeeVault += protocolFee;
        creatorFeeVault += creatorFee;

        payable(msg.sender).sendValue(netQuoteOut);

        emit SellExecuted(
            msg.sender,
            tokenAmount,
            grossQuoteOut,
            netQuoteOut,
            protocolFee,
            creatorFee,
            curveQuoteReserve,
            saleTokenReserve
        );
    }

    function claimProtocolFees() external nonReentrant returns (uint256 amount) {
        if (msg.sender != protocolFeeRecipient) revert Unauthorized();
        amount = protocolFeeVault;
        if (amount == 0) revert NothingToClaim();

        protocolFeeVault = 0;
        payable(protocolFeeRecipient).sendValue(amount);

        emit ProtocolFeesClaimed(protocolFeeRecipient, amount);
    }

    function claimCreatorFees() external nonReentrant returns (uint256 amount) {
        if (msg.sender != creator) revert Unauthorized();
        if (state != LaunchState.DEXOnly) revert InvalidState();

        amount = creatorFeeVault;
        if (amount == 0) revert NothingToClaim();

        creatorFeeVault = 0;
        payable(creator).sendValue(amount);

        emit CreatorFeesClaimed(creator, amount);
    }

    function previewBuy(uint256 grossQuoteIn)
        external
        view
        returns (uint256 tokenOut, uint256 feeAmount, uint256 refundAmount)
    {
        if (grossQuoteIn == 0) {
            return (0, 0, 0);
        }

        (uint256 usedGross, uint256 netQuoteIn, uint256 protocolFee, uint256 creatorFee) = _quoteBuy(grossQuoteIn);
        tokenOut = _buyTokenOut(netQuoteIn);
        feeAmount = protocolFee + creatorFee;
        refundAmount = grossQuoteIn - usedGross;
    }

    function previewSell(uint256 tokenAmount)
        external
        view
        returns (uint256 grossQuoteOut, uint256 netQuoteOut, uint256 totalFee)
    {
        if (tokenAmount == 0) {
            return (0, 0, 0);
        }

        (uint256 effectiveQuoteReserve, uint256 effectiveTokenReserve) = _effectiveReserves();
        uint256 invariant = effectiveQuoteReserve * effectiveTokenReserve;
        uint256 newEffectiveTokenReserve = effectiveTokenReserve + tokenAmount;
        uint256 newEffectiveQuoteReserve = Math.ceilDiv(invariant, newEffectiveTokenReserve);

        grossQuoteOut = effectiveQuoteReserve - newEffectiveQuoteReserve;
        (totalFee,,) = _splitFees(grossQuoteOut);
        netQuoteOut = grossQuoteOut - totalFee;
    }

    function priceQuotePerToken() external view returns (uint256) {
        (uint256 effectiveQuoteReserve, uint256 effectiveTokenReserve) = _effectiveReserves();
        return (effectiveQuoteReserve * 1e18) / effectiveTokenReserve;
    }

    function currentPriceQuotePerToken() external view returns (uint256) {
        if (state == LaunchState.DEXOnly) {
            (uint256 tokenReserve, uint256 quoteReserve) = _dexReserves();
            if (tokenReserve == 0) {
                return 0;
            }
            return (quoteReserve * 1e18) / tokenReserve;
        }

        (uint256 effectiveQuoteReserve, uint256 effectiveTokenReserve) = _effectiveReserves();
        return (effectiveQuoteReserve * 1e18) / effectiveTokenReserve;
    }

    function remainingQuoteCapacity() external view returns (uint256) {
        if (state == LaunchState.DEXOnly) {
            return 0;
        }
        return graduationQuoteReserve - curveQuoteReserve;
    }

    function graduationProgressBps() external view returns (uint256) {
        return (curveQuoteReserve * BPS_DENOMINATOR) / graduationQuoteReserve;
    }

    function displayGraduationProgressBps() external view returns (uint256) {
        if (state == LaunchState.DEXOnly) {
            return BPS_DENOMINATOR;
        }
        return (curveQuoteReserve * BPS_DENOMINATOR) / graduationQuoteReserve;
    }

    function sellUnlockBlock(address account) external view returns (uint256) {
        uint256 lastBuy = lastBuyBlock[account];
        if (lastBuy == 0) return 0;
        return lastBuy + 1;
    }

    function canSell(address account) external view returns (bool) {
        uint256 lastBuy = lastBuyBlock[account];
        return lastBuy == 0 || block.number > lastBuy;
    }

    function isPairClean() external view returns (bool) {
        return _pairIsClean();
    }

    function isPairGraduationCompatible() external view returns (bool) {
        return _pairAllowsGraduation();
    }

    function pairPreloadedQuote() external view returns (uint256) {
        if (pair == address(0)) {
            return 0;
        }
        return IERC20Minimal(wrappedNative).balanceOf(pair);
    }

    function protocolClaimable() external view returns (uint256) {
        return protocolFeeVault;
    }

    function creatorClaimable() external view returns (uint256) {
        if (state != LaunchState.DEXOnly) {
            return 0;
        }
        return creatorFeeVault;
    }

    function dexReserves() external view returns (uint256 tokenReserve, uint256 quoteReserve) {
        return _dexReserves();
    }

    function pairSnapshot()
        external
        view
        returns (
            address pairAddress,
            uint256 pairTotalSupply,
            uint112 reserve0,
            uint112 reserve1,
            uint256 tokenBalance,
            uint256 wrappedNativeBalance
        )
    {
        pairAddress = pair;
        if (pairAddress == address(0)) {
            return (address(0), 0, 0, 0, 0, 0);
        }

        IUniswapV2LikePair lpPair = IUniswapV2LikePair(pairAddress);
        pairTotalSupply = lpPair.totalSupply();
        (reserve0, reserve1,) = lpPair.getReserves();
        tokenBalance = balanceOf(pairAddress);
        wrappedNativeBalance = IERC20Minimal(wrappedNative).balanceOf(pairAddress);
    }

    function accountedNativeBalance() external view returns (uint256) {
        return curveQuoteReserve + protocolFeeVault + creatorFeeVault;
    }

    function unexpectedNativeBalance() external view returns (uint256) {
        uint256 accounted = curveQuoteReserve + protocolFeeVault + creatorFeeVault;
        if (address(this).balance <= accounted) {
            return 0;
        }
        return address(this).balance - accounted;
    }

    function transfer(address to, uint256 value) public virtual override returns (bool) {
        if (state != LaunchState.DEXOnly) revert TransferDisabledPreGraduation();
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public virtual override returns (bool) {
        if (state != LaunchState.DEXOnly) {
            bool migrationPull = state == LaunchState.Migrating && from == address(this);
            if (!migrationPull) revert TransferDisabledPreGraduation();
        }
        return super.transferFrom(from, to, value);
    }

    function _buy(address recipient, uint256 minTokenOut) internal returns (uint256 tokenOut) {
        if (recipient != msg.sender || recipient == address(0) || recipient == address(this) || recipient == pair) {
            revert InvalidRecipient();
        }
        if (msg.value == 0) revert ZeroAmount();

        (uint256 usedGross, uint256 netQuoteIn, uint256 protocolFee, uint256 creatorFee) = _quoteBuy(msg.value);
        if (usedGross == 0 || netQuoteIn == 0) revert ZeroAmount();

        bool reachesGraduationBoundary = curveQuoteReserve + netQuoteIn == graduationQuoteReserve;
        tokenOut = _buyTokenOut(netQuoteIn);
        if (reachesGraduationBoundary) {
            tokenOut = saleTokenReserve;
        }

        if (tokenOut == 0 || tokenOut > saleTokenReserve) revert SlippageExceeded();
        if (tokenOut < minTokenOut) revert SlippageExceeded();

        curveQuoteReserve += netQuoteIn;
        protocolFeeVault += protocolFee;
        creatorFeeVault += creatorFee;
        saleTokenReserve -= tokenOut;

        _transfer(address(this), recipient, tokenOut);
        lastBuyBlock[recipient] = block.number;

        uint256 refundAmount = msg.value - usedGross;
        if (refundAmount > 0) {
            payable(msg.sender).sendValue(refundAmount);
        }

        emit BuyExecuted(
            msg.sender,
            usedGross,
            netQuoteIn,
            protocolFee,
            creatorFee,
            refundAmount,
            tokenOut,
            curveQuoteReserve,
            saleTokenReserve
        );

        if (curveQuoteReserve >= graduationQuoteReserve || saleTokenReserve == 0) {
            _graduate();
        }
    }

    function _quoteBuy(uint256 grossQuoteIn)
        internal
        view
        returns (uint256 usedGross, uint256 netQuoteIn, uint256 protocolFee, uint256 creatorFee)
    {
        uint256 remainingCapacity = graduationQuoteReserve - curveQuoteReserve;
        if (remainingCapacity == 0) revert GraduationAlreadyTriggered();

        (uint256 tentativeFee,,) = _splitFees(grossQuoteIn);
        uint256 tentativeNet = grossQuoteIn - tentativeFee;

        if (tentativeNet <= remainingCapacity) {
            usedGross = grossQuoteIn;
            netQuoteIn = tentativeNet;
        } else {
            usedGross = Math.mulDiv(
                remainingCapacity,
                BPS_DENOMINATOR,
                BPS_DENOMINATOR - TOTAL_FEE_BPS,
                Math.Rounding.Ceil
            );

            while (usedGross > 0) {
                (uint256 feeCheck,,) = _splitFees(usedGross);
                uint256 netCheck = usedGross - feeCheck;
                if (netCheck <= remainingCapacity) {
                    break;
                }
                usedGross -= 1;
            }

            (uint256 finalFeeCheck,,) = _splitFees(usedGross);
            netQuoteIn = usedGross - finalFeeCheck;
        }

        (, protocolFee, creatorFee) = _splitFees(usedGross);
    }

    function _graduate() internal {
        if (state != LaunchState.Bonding314) revert InvalidState();
        if (curveQuoteReserve != graduationQuoteReserve) revert SlippageExceeded();

        LaunchState previousState = state;
        state = LaunchState.Migrating;
        emit StateTransition(previousState, LaunchState.Migrating);

        _assertPairAllowsGraduation();

        uint256 tokenAmount = lpTokenReserve;
        uint256 quoteAmount = curveQuoteReserve;
        uint256 preloadedQuoteAmount = IERC20Minimal(wrappedNative).balanceOf(pair);

        _transfer(address(this), pair, tokenAmount);
        IWrappedNative(wrappedNative).deposit{value: quoteAmount}();
        bool wrappedTransferOk = IWrappedNative(wrappedNative).transfer(pair, quoteAmount);
        if (!wrappedTransferOk) revert WrappedQuoteTransferFailed();

        uint256 liquidityBurned = IUniswapV2LikePair(pair).mint(DEAD_ADDRESS);

        lpTokenReserve = 0;
        curveQuoteReserve = 0;

        previousState = state;
        state = LaunchState.DEXOnly;
        emit StateTransition(previousState, LaunchState.DEXOnly);
        emit Graduated(pair, tokenAmount, quoteAmount, preloadedQuoteAmount, liquidityBurned);
    }

    function _assertPairIsClean() internal view {
        if (!_pairIsClean()) revert PairPolluted();
    }

    function _assertPairAllowsGraduation() internal view {
        if (!_pairAllowsGraduation()) revert PairPolluted();
    }

    function _pairIsClean() internal view returns (bool) {
        if (pair == address(0)) return false;

        IUniswapV2LikePair lpPair = IUniswapV2LikePair(pair);
        if (lpPair.totalSupply() != 0) return false;

        (uint112 reserve0, uint112 reserve1,) = lpPair.getReserves();
        if (reserve0 != 0 || reserve1 != 0) return false;

        if (balanceOf(pair) != 0) return false;
        if (IERC20Minimal(wrappedNative).balanceOf(pair) != 0) return false;

        return true;
    }

    function _pairAllowsGraduation() internal view returns (bool) {
        if (pair == address(0)) return false;

        IUniswapV2LikePair lpPair = IUniswapV2LikePair(pair);
        if (lpPair.totalSupply() != 0) return false;

        if (balanceOf(pair) != 0) return false;

        (uint112 reserve0, uint112 reserve1,) = lpPair.getReserves();
        address token0 = lpPair.token0();
        address token1 = lpPair.token1();

        if (token0 == address(this) && reserve0 != 0) return false;
        if (token1 == address(this) && reserve1 != 0) return false;

        return true;
    }

    function _buyTokenOut(uint256 netQuoteIn) internal view returns (uint256 tokenOut) {
        if (curveQuoteReserve + netQuoteIn == graduationQuoteReserve) {
            return saleTokenReserve;
        }

        (uint256 effectiveQuoteReserve, uint256 effectiveTokenReserve) = _effectiveReserves();
        uint256 invariant = effectiveQuoteReserve * effectiveTokenReserve;
        uint256 newEffectiveQuoteReserve = effectiveQuoteReserve + netQuoteIn;
        uint256 newEffectiveTokenReserve = invariant / newEffectiveQuoteReserve;
        tokenOut = effectiveTokenReserve - newEffectiveTokenReserve;
    }

    function _effectiveReserves() internal view returns (uint256 effectiveQuoteReserve, uint256 effectiveTokenReserve) {
        effectiveQuoteReserve = curveQuoteReserve + virtualQuoteReserve;
        effectiveTokenReserve = saleTokenReserve + lpTokenReserve + virtualTokenReserve;
    }

    function _dexReserves() internal view returns (uint256 tokenReserve, uint256 quoteReserve) {
        if (pair == address(0)) {
            return (0, 0);
        }

        IUniswapV2LikePair lpPair = IUniswapV2LikePair(pair);
        (uint112 reserve0, uint112 reserve1,) = lpPair.getReserves();
        address token0 = lpPair.token0();

        if (token0 == address(this)) {
            tokenReserve = reserve0;
            quoteReserve = reserve1;
        } else {
            tokenReserve = reserve1;
            quoteReserve = reserve0;
        }
    }

    function _splitFees(uint256 grossAmount)
        internal
        pure
        returns (uint256 totalFee, uint256 protocolFee, uint256 creatorFee)
    {
        totalFee = (grossAmount * TOTAL_FEE_BPS) / BPS_DENOMINATOR;
        protocolFee = (grossAmount * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        creatorFee = totalFee - protocolFee;
    }

    function _ensurePair() internal returns (address ensuredPair) {
        ensuredPair = IUniswapV2LikeFactory(dexFactory).getPair(address(this), wrappedNative);
        if (ensuredPair == address(0)) {
            ensuredPair = IUniswapV2LikeFactory(dexFactory).createPair(address(this), wrappedNative);
        }
    }

    function _update(address from, address to, uint256 value) internal override {
        if (state == LaunchState.Bonding314) {
            bool isMintOrBurn = from == address(0) || to == address(0);
            bool isProtocolTransfer = from == address(this) || to == address(this);
            if (!isMintOrBurn && !isProtocolTransfer) {
                revert TransferDisabledPreGraduation();
            }
        } else if (state == LaunchState.Migrating) {
            bool migrationAllowed = from == address(this);
            if (!migrationAllowed) {
                revert InvalidState();
            }
        } else if (state == LaunchState.DEXOnly) {
            if (to == address(this)) {
                revert InvalidRecipient();
            }
        }

        super._update(from, to, value);
    }
}

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
}

interface IWrappedNative is IERC20Minimal {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
}
