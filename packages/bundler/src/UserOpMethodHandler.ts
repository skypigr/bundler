import { BigNumber, Wallet } from 'ethers'
import { JsonRpcProvider, JsonRpcSigner, Log, Provider } from '@ethersproject/providers'

import { BundlerConfig } from './BundlerConfig'
import { resolveProperties } from 'ethers/lib/utils'
import { AddressZero, deepHexlify } from '@account-abstraction/utils'
import { EntryPoint__factory, UserOperationStruct, EntryPoint } from '@account-abstraction/contracts'
import { UserOperationEventEvent } from '@account-abstraction/contracts/dist/types/EntryPoint'
import { calcPreVerificationGas } from '@account-abstraction/sdk'
import { requireCond } from './utils'
import { EstimateUserOpGasResult, UserOperationReceipt } from './RpcTypes'
import { ExecutionManager } from './modules/ExecutionManager'
import { getAddr } from './modules/moduleUtils'

const HEX_REGEX = /^0x[a-fA-F\d]*$/i

export class UserOpMethodHandler {
  constructor (
    readonly execManager: ExecutionManager,
    readonly provider: Provider,
    readonly signer: Wallet | JsonRpcSigner,
    readonly config: BundlerConfig,
    readonly entryPoint: EntryPoint
  ) {
  }

  async getSupportedEntryPoints (): Promise<string[]> {
    return [this.config.entryPoint]
  }

  async selectBeneficiary (): Promise<string> {
    const currentBalance = await this.provider.getBalance(this.signer.getAddress())
    let beneficiary = this.config.beneficiary
    // below min-balance redeem to the signer, to keep it active.
    if (currentBalance.lte(this.config.minBalance)) {
      beneficiary = await this.signer.getAddress()
      console.log('low balance. using ', beneficiary, 'as beneficiary instead of ', this.config.beneficiary)
    }
    return beneficiary
  }

  async _validateParameters (userOp1: UserOperationStruct, entryPointInput: string, requireSignature = true, requireGasParams = true): Promise<void> {
    requireCond(entryPointInput != null, 'No entryPoint param', -32602)

    if (entryPointInput?.toString().toLowerCase() !== this.config.entryPoint.toLowerCase()) {
      throw new Error(`The EntryPoint at "${entryPointInput}" is not supported. This bundler uses ${this.config.entryPoint}`)
    }

    // minimal sanity check: userOp exists, and all members are hex
    requireCond(userOp1 != null, 'No UserOperation param')
    const userOp = await resolveProperties(userOp1) as any

    const fields = ['sender', 'nonce', 'initCode', 'callData', 'paymasterAndData']
    if (requireSignature) {
      fields.push('signature')
    }
    if (requireGasParams) {
      fields.push('preVerificationGas', 'verificationGasLimit', 'callGasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas')
    }
    fields.forEach(key => {
      requireCond(userOp[key] != null, 'Missing userOp field: ' + key + JSON.stringify(userOp), -32602)
      const value: string = userOp[key].toString()
      requireCond(value.match(HEX_REGEX) != null, `Invalid hex value for property ${key}:${value} in UserOp`, -32602)
    })
  }

  /**
   * eth_estimateUserOperationGas RPC api.
   * @param userOp1
   * @param entryPointInput
   */
  async estimateUserOperationGas (userOp1: UserOperationStruct, entryPointInput: string): Promise<EstimateUserOpGasResult> {
    const provider = this.provider as JsonRpcProvider

    const userOp = {
      ...await resolveProperties(userOp1),

      // default values for missing fields.
      paymasterAndData: '0x',
      signature: '0x'.padEnd(66 * 2, '1b'), // TODO: each wallet has to put in a signature in the correct length
      maxFeePerGas: 0,
      maxPriorityFeePerGas: 0,
      preVerificationGas: 0,
      verificationGasLimit: 10e6
    }

    // todo: checks the existence of parameters, but since we hexlify the inputs, it fails to validate
    await this._validateParameters(deepHexlify(userOp), entryPointInput)

    const entryPointFromAddrZero = EntryPoint__factory.connect(entryPointInput, provider.getSigner(AddressZero))
    const errorResult = await entryPointFromAddrZero.callStatic.simulateValidation(userOp).catch(e => e)
    if (errorResult.errorName !== 'SimulationResult') {
      throw errorResult
    }

    let {
      preOpGas,
      deadline
    } = errorResult.errorArgs
    const callGasLimit = await this.provider.estimateGas({
      from: this.entryPoint.address,
      to: userOp.sender,
      data: userOp.callData
    }).then(b => b.toNumber())
    deadline = BigNumber.from(deadline)
    if (deadline === 0) {
      deadline = undefined
    }
    const preVerificationGas = calcPreVerificationGas(userOp)
    const verificationGas = BigNumber.from(preOpGas).toNumber()
    return {
      preVerificationGas,
      verificationGas,
      deadline,
      callGasLimit
    }
  }

  async sendUserOperation (userOp1: UserOperationStruct, entryPointInput: string): Promise<string> {
    await this._validateParameters(userOp1, entryPointInput)

    const userOp = await resolveProperties(userOp1)

    console.log(`UserOperation: Sender=${userOp.sender} EntryPoint=${entryPointInput} Paymaster=${getAddr(userOp.paymasterAndData)}`)
    await this.execManager.sendUserOperation(userOp, entryPointInput)
    return await this.entryPoint.getUserOpHash(userOp)
  }

  async _getUserOperationEvent (userOpHash: string): Promise<UserOperationEventEvent> {
    // TODO: eth_getLogs is throttled. must be acceptable for finding a UserOperation by hash
    const event = await this.entryPoint.queryFilter(this.entryPoint.filters.UserOperationEvent(userOpHash))
    return event[0]
  }

  // filter full bundle logs, and leave only logs for the given userOpHash
  // @param userOpEvent - the event of our UserOp (known to exist in the logs)
  // @param logs - full bundle logs. after each group of logs there is a single UserOperationEvent with unique hash.
  _filterLogs (userOpEvent: UserOperationEventEvent, logs: Log[]): Log[] {
    let startIndex = -1
    let endIndex = -1
    logs.forEach((log, index) => {
      if (log?.topics[0] === userOpEvent.topics[0]) {
        // process UserOperationEvent
        if (log.topics[1] === userOpEvent.topics[1]) {
          // it's our userOpHash. save as end of logs array
          endIndex = index
        } else {
          // it's a different hash. remember it as beginning index, but only if we didn't find our end index yet.
          if (endIndex === -1) {
            startIndex = index
          }
        }
      }
    })
    if (endIndex === -1) {
      throw new Error('fatal: no UserOperationEvent in logs')
    }
    return logs.slice(startIndex + 1, endIndex)
  }

  async getUserOperationReceipt (userOpHash: string): Promise<UserOperationReceipt | null> {
    requireCond(userOpHash?.toString()?.match(HEX_REGEX) != null, 'Missing/invalid userOpHash', -32601)
    const event = await this._getUserOperationEvent(userOpHash)
    if (event == null) {
      return null
    }
    const receipt = await event.getTransactionReceipt()
    const logs = this._filterLogs(event, receipt.logs)
    return deepHexlify({
      userOpHash,
      sender: event.args.sender,
      nonce: event.args.nonce,
      actualGasCost: event.args.actualGasCost,
      actualGasUsed: event.args.actualGasUsed,
      success: event.args.success,
      logs,
      receipt
    })
  }

  clientVersion (): string {
    // eslint-disable-next-line
    return 'aa-bundler/' + require('../package.json').version
  }
}
