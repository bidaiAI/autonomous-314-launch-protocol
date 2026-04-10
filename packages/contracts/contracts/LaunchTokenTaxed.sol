// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchToken} from "./LaunchToken.sol";
import {ILaunchFactoryRegistry} from "./interfaces/ILaunchFactoryRegistry.sol";

contract LaunchTokenTaxed is LaunchToken {
    error InvalidTaxConfig();
    error UnauthorizedTaxedFactoryDeployment();
    error UnauthorizedTaxablePoolManager();
    error InvalidTaxablePool();
    error CanonicalTaxablePoolRequired();

    struct TaxedConstructorArgs {
        string name;
        string symbol;
        string metadataURI;
        address creator;
        address factory;
        address protocolFeeRecipient;
        address router;
        uint256 graduationQuoteReserve;
        uint8 launchModeId;
        uint16 taxBps;
        uint16 burnShareBps;
        uint16 treasuryShareBps;
        address treasuryWallet;
    }

    uint16 private immutable _taxBps;
    uint16 private immutable _burnShareBps;
    uint16 private immutable _treasuryShareBps;
    address private immutable _treasuryWallet;
    mapping(address => bool) public isTaxablePool;

    event TaxApplied(
        address indexed from,
        address indexed to,
        uint256 grossAmount,
        uint256 taxAmount,
        uint256 burnAmount,
        uint256 treasuryAmount
    );
    event TaxablePoolUpdated(address indexed pool, bool enabled, bool canonicalPair);

    constructor(TaxedConstructorArgs memory args) LaunchToken(
        LaunchToken.ConstructorArgs({
            name: args.name,
            symbol: args.symbol,
            metadataURI: args.metadataURI,
            creator: args.creator,
            factory: args.factory,
            protocolFeeRecipient: args.protocolFeeRecipient,
            router: args.router,
            graduationQuoteReserve: args.graduationQuoteReserve,
            launchModeId: args.launchModeId
        })
    ) {
        _validateTaxConfig(args.launchModeId, args.taxBps, args.burnShareBps, args.treasuryShareBps, args.treasuryWallet);
        _taxBps = args.taxBps;
        _burnShareBps = args.burnShareBps;
        _treasuryShareBps = args.treasuryShareBps;
        _treasuryWallet = args.treasuryWallet;
        _setTaxablePool(pair, true);
        if (!_isAuthorizedTaxedFactoryDeployment(args.factory)) revert UnauthorizedTaxedFactoryDeployment();
    }

    function launchSuffix() public view override returns (string memory) {
        if (_taxBps == 100) return "1314";
        if (_taxBps == 200) return "2314";
        if (_taxBps == 300) return "3314";
        if (_taxBps == 400) return "4314";
        if (_taxBps == 500) return "5314";
        if (_taxBps == 600) return "6314";
        if (_taxBps == 700) return "7314";
        if (_taxBps == 800) return "8314";
        return "9314";
    }

    function taxConfig()
        external
        view
        override
        returns (bool enabled, uint16 configuredTaxBps, uint16 burnBps, uint16 treasuryBps, address wallet, bool active)
    {
        return (true, _taxBps, _burnShareBps, _treasuryShareBps, _treasuryWallet, state == LaunchState.DEXOnly);
    }

    function setTaxablePool(address pool, bool enabled) external {
        if (!_canManageTaxablePools(msg.sender)) revert UnauthorizedTaxablePoolManager();
        if (pool == pair && !enabled) revert CanonicalTaxablePoolRequired();
        if (enabled && !_isValidTaxablePool(pool)) revert InvalidTaxablePool();
        _setTaxablePool(pool, enabled);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (_shouldApplyTax(from, to, value)) {
            uint256 taxAmount = (value * _taxBps) / BPS_DENOMINATOR;
            if (taxAmount != 0) {
                uint256 burnAmount = (taxAmount * _burnShareBps) / BPS_DENOMINATOR;
                uint256 treasuryAmount = taxAmount - burnAmount;
                uint256 netAmount = value - taxAmount;

                super._update(from, to, netAmount);
                if (burnAmount != 0) {
                    super._update(from, DEAD_ADDRESS, burnAmount);
                }
                if (treasuryAmount != 0) {
                    super._update(from, _treasuryWallet, treasuryAmount);
                }

                emit TaxApplied(from, to, value, taxAmount, burnAmount, treasuryAmount);
                return;
            }
        }

        super._update(from, to, value);
    }

    function _shouldApplyTax(address from, address to, uint256 value) internal view returns (bool) {
        if (value == 0) return false;
        if (state != LaunchState.DEXOnly) return false;
        if (from == address(0) || to == address(0)) return false;
        return isTaxablePool[from] || isTaxablePool[to];
    }

    function _validateTaxConfig(
        uint8 launchModeId_,
        uint16 taxBps_,
        uint16 burnShareBps_,
        uint16 treasuryShareBps_,
        address treasuryWallet_
    ) internal view {
        if (_modeForTaxBps(taxBps_) != launchModeId_) revert InvalidTaxConfig();
        if (burnShareBps_ + treasuryShareBps_ != uint16(BPS_DENOMINATOR)) revert InvalidTaxConfig();
        if (treasuryShareBps_ > 0 && treasuryWallet_ == address(0)) revert InvalidTaxConfig();
        if (treasuryShareBps_ == 0 && treasuryWallet_ != address(0)) revert InvalidTaxConfig();
        if (treasuryWallet_ == address(this) || treasuryWallet_ == pair || treasuryWallet_ == DEAD_ADDRESS) {
            revert InvalidTaxConfig();
        }
    }

    function _isAuthorizedTaxedFactoryDeployment(address factory_) private view returns (bool) {
        if (msg.sender == factory_) return true;
        if (factory_.code.length == 0) return false;
        return msg.sender == ILaunchFactoryRegistry(factory_).taxedDeployer();
    }

    function _canManageTaxablePools(address account) private view returns (bool) {
        if (account == creator) return true;
        if (factory.code.length == 0) return false;

        (bool success, bytes memory data) = factory.staticcall(abi.encodeWithSignature("owner()"));
        return success && data.length >= 32 && abi.decode(data, (address)) == account;
    }

    function _isValidTaxablePool(address pool) private view returns (bool) {
        if (pool == address(0) || pool == address(this) || pool.code.length == 0) return false;

        (bool token0Ok, bytes memory token0Data) = pool.staticcall(abi.encodeWithSignature("token0()"));
        (bool token1Ok, bytes memory token1Data) = pool.staticcall(abi.encodeWithSignature("token1()"));
        (bool factoryOk, bytes memory factoryData) = pool.staticcall(abi.encodeWithSignature("factory()"));
        if (
            !token0Ok || token0Data.length < 32 || !token1Ok || token1Data.length < 32 || !factoryOk
                || factoryData.length < 32
        ) return false;

        address token0 = abi.decode(token0Data, (address));
        address token1 = abi.decode(token1Data, (address));
        address poolFactory = abi.decode(factoryData, (address));
        if (poolFactory == address(0) || poolFactory.code.length == 0) return false;

        return token0 == address(this) || token1 == address(this);
    }

    function _setTaxablePool(address pool, bool enabled) private {
        bool current = isTaxablePool[pool];
        if (current == enabled) return;
        isTaxablePool[pool] = enabled;
        emit TaxablePoolUpdated(pool, enabled, pool == pair);
    }

    function _modeForTaxBps(uint16 taxBps_) private pure returns (uint8) {
        if (taxBps_ == 100) return MODE_TAXED_1314;
        if (taxBps_ == 200) return MODE_TAXED_2314;
        if (taxBps_ == 300) return MODE_TAXED_3314;
        if (taxBps_ == 400) return MODE_TAXED_4314;
        if (taxBps_ == 500) return MODE_TAXED_5314;
        if (taxBps_ == 600) return MODE_TAXED_6314;
        if (taxBps_ == 700) return MODE_TAXED_7314;
        if (taxBps_ == 800) return MODE_TAXED_8314;
        if (taxBps_ == 900) return MODE_TAXED_9314;
        revert InvalidTaxConfig();
    }
}
