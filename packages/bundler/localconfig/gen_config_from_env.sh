#!/bin/sh

# Required ENV variables:
#  - BUNDLER_ENV_ENTRYPOINT: EntryPoint address
#  - BUNDLER_ENV_BENEFICIARY: Beneficiary address
#  - BUNDLER_ENV_NETWORK: The URL of a block RPC endpoint
#
# Optional ENV variables:
#  - BUNDLER_ENV_PORT: port number this bundler server will liston on,
#                      default to 3000 if not provided.


_FILE_PREFIX="local"
_CONFIG_FILE_NAME="$_FILE_PREFIX.bundler.config.json"
_MNEMONIC_FILE_NAME="$_FILE_PREFIX.mnemonic.txt"
_PORT="${BUNDLER_ENV_PORT:=3000}"

# Writes mnemonic phrases to a local config file;
echo $BUNDLER_ENV_MNEMONIC > ../localconfig/$_MNEMONIC_FILE_NAME

# Constructs a config from env and writes it to a local file.
# TODO(xiaozhu): we may want to add validation on key env variables.
cat > ../localconfig/$_CONFIG_FILE_NAME <<- EOM
{
    "gasFactor": "1",
    "port": "$_PORT",
    "network": "$BUNDLER_ENV_NETWORK",
    "entryPoint": "$BUNDLER_ENV_ENTRYPOINT",
    "beneficiary": "$BUNDLER_ENV_BENEFICIARY",
    "minBalance": "1",
    "mnemonic": "./localconfig/$_MNEMONIC_FILE_NAME",
    "maxBundleGas": 5e6,
    "minStake": "1",
    "minUnstakeDelay": 0,
    "autoBundleInterval": 3,
    "autoBundleMempoolSize": 10
}
EOM
