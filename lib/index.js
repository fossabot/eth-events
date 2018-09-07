'use strict'

const EthAbi = require('ethjs-abi')
const utils = require('ethers/utils')
const map = require('lodash/fp/map')
const find = require('lodash/fp/find')
const every = require('lodash/fp/every')
const zipWith = require('lodash/fp/zipWith')
const isArray = require('lodash/fp/isArray')
const includes = require('lodash/fp/includes')
const isString = require('lodash/fp/isString')
const isUndefined = require('lodash/fp/isUndefined')

class EthEvents {
  constructor(ethjs, contract, blockRangeThreshold = 10000) {
    this.eth = ethjs
    this.contract = contract
    this.blockRangeThreshold = blockRangeThreshold
    this.decoder = EthAbi.logDecoder(contract.abi)
    this.getLogs = this.getLogs.bind(this)
    this.batchGetLogs = this.batchGetLogs.bind(this)
    this.normalizeLogs = this.normalizeLogs.bind(this)
    this.validateBlockNumbers = this.validateBlockNumbers.bind(this)
    this.getDecodedNormalizedLogs = this.getDecodedNormalizedLogs.bind(this)
    this.checkCode()
  }

  // Verifies there's a contract that exists at the specified address & network
  async checkCode() {
    const code = await this.eth.getCode(this.contract.address)
    if (code === '0x') {
      throw new Error('NO CODE')
    }
    return true
  }

  // prettier-ignore
  // Validates block range
  validateBlockNumbers(fromBlock, toBlock, currentBlock) {
    if (fromBlock > currentBlock || fromBlock < 0) {
      throw new Error('Invalid fromBlock. It must be less than the currentBlock || it cannot be negative')
    }
    if (fromBlock > toBlock) {
      throw new Error('Invalid fromBlock. It must be less than toBlock')
    }
    if (toBlock > currentBlock) {
      throw new Error('Invalid toBlock. It must be less than or equal to the currentblock')
    }
  }

  // prettier-ignore
  // Gets logs using a block range
  async getLogs(fromBlock = 0, toBlock = 'latest', eventNames = [], indexedFilterValues = {}, batch = false) {
    try {
      // Get the current block number
      const currentBlock = (await this.eth.blockNumber()).toNumber()
      console.log('')
      console.log('currentBlock:', currentBlock)

      // Validate block range
      this.validateBlockNumbers(fromBlock, toBlock, currentBlock)

      // Edit toBlock if string is provided
      if (toBlock === 'latest') {
        toBlock = currentBlock
      }

      // Create a filter with the appropriate block_numbers and topics
      const filter = this.createFilter(
        { fromBlock, toBlock }, eventNames, indexedFilterValues
      )

      // CASE: Too large of a gap -- over the block range threshold!
      if (batch && toBlock - fromBlock > this.blockRangeThreshold) {
        console.log('')
        console.log(`Batching logs from ${fromBlock} to ${toBlock}...`)
        // Edit the filter for the first batched set of blocks
        const newFilter = {
          ...filter,
          toBlock: fromBlock + this.blockRangeThreshold
        }
        return this.batchGetLogs(newFilter, toBlock)
      }

      // CASE: within threshold range. get logs
      return this.getDecodedNormalizedLogs(filter)
    } catch (error) {
      console.log('Error while trying to get and decode logs:', error.toString())
      return error
    }
  }

  // If block range is not within the threshold, batch getLogs using the threshold value
  async batchGetLogs(filter, finalBlock, logs = []) {
    try {
      if (filter.toBlock < finalBlock) {
        // -----------------------------------
        // toBlock is less than the finalBlock
        // Get logs with the incoming filter
        // -----------------------------------

        const normalizedLogs = await this.getDecodedNormalizedLogs(filter)
        // Concat the accumulation of logs
        const accLogs = logs.concat(normalizedLogs)

        // From: to +1
        // To: to + threshold
        const newFilter = {
          ...filter,
          fromBlock: filter.toBlock + 1,
          toBlock: filter.toBlock + this.blockRangeThreshold,
        }
        console.log('Subtotal logs:', accLogs.length)
        console.log('Remaining blocks:', finalBlock - newFilter.fromBlock)
        console.log('')

        // Recurse: new filter, new accumulation of logs
        return this.batchGetLogs(newFilter, finalBlock, accLogs)
      }

      // ----------------------------------------
      // toBlock is > finalBlock
      // Get final logs from the remaining blocks
      // ----------------------------------------

      const lastFilter = {
        ...filter,
        toBlock: finalBlock,
      }
      const finalNormalizedLogs = await this.getDecodedNormalizedLogs(lastFilter)
      console.log('')
      console.log('Total logs:', finalNormalizedLogs.length)
      console.log('')

      // Return final array of decoded normalized logs
      return logs.concat(finalNormalizedLogs)
    } catch (error) {
      console.log('error:', error)
      throw new Error('Error while recursively batching logs:', error.toString())
    }
  }

  async getDecodedNormalizedLogs(filter) {
    console.log(`Search: ${filter.fromBlock} - ${filter.toBlock}`)
    // prettier-ignore
    const rawLogs = (await this.eth.getLogs(filter)).filter(log => this.matchesFilter(log, filter))
    if (rawLogs.length) {
      console.log(`Found ${rawLogs.length} logs`)
    }
    const decodedLogs = this.decoder(rawLogs)
    return this.normalizeLogs(rawLogs, decodedLogs)
  }

  // Normalize/consolidate return data
  // Return: { logData, txData, eventName }
  async normalizeLogs(rawLogs, decodedLogs) {
    try {
      return Promise.all(
        rawLogs.map(async (log, index) => {
          try {
            const block = await this.eth.getBlockByHash(log.blockHash, false)
            const tx = await this.eth.getTransactionByHash(log.transactionHash)
            // Decoded log
            const logData = decodedLogs[index]
            // Block and transaction essentials
            const txData = {
              txHash: tx.hash,
              logIndex: rawLogs[index].logIndex.toString(),
              blockNumber: block.number.toString(),
              blockTimestamp: block.timestamp.toString(),
            }
            // TODO: maybe flatten?
            return {
              logData,
              txData,
              contractAddress: log.address,
              eventName: logData._eventName,
            }
          } catch (error) {
            console.log('Error while trying to decode logs:', error)
          }
        })
      )
    } catch (error) {
      console.log('Error while trying to normalize logs:', error.toString())
    }
  }

  // prettier-ignore
  // adapted from:
  // https://github.com/0xProject/0x.js/blob/development/packages/0x.js/src/utils/filter_utils.ts#L15
  createFilter(blockRange, eventNames = [], indexFilterValues = {}) {
    const { abi, address } = this.contract
    const { fromBlock, toBlock } = blockRange

    // Empty array of event names
    if (eventNames.length === 0) {
      return { fromBlock, toBlock, address, topics: [] }
    }

    // Get event signature topics -- filter.topics[0]
    const evSigTopics = eventNames.map(eventName => {
      const eventAbi = find({ 'name': eventName }, abi)
      const eventString = this.getEventStringFromAbiName(eventAbi)
      const eventSignature = utils.id(eventString)
      const eventSignatureTopic = utils.hexlify(eventSignature)
      return eventSignatureTopic
    })

    // Get the rest of the topics
    const eventAbi = find({ 'name': eventNames[0] }, abi)
    const topicsForIndexedArgs = this.getTopicsForIndexedArgs(eventAbi, indexFilterValues)
    const topics = [evSigTopics, ...topicsForIndexedArgs]

    if (!isUndefined(blockRange) && blockRange.fromBlock && blockRange.toBlock) {
      return { fromBlock, toBlock, address, topics }
    }
    return { address, topics }
  }

  // Returns tightly-packed event signature string
  getEventStringFromAbiName(eventAbi) {
    const types = map('type', eventAbi.inputs)
    const signature = `${eventAbi.name}(${types.join(',')})`
    return signature
  }

  // Returns
  getTopicsForIndexedArgs(abi, indexFilterValues) {
    const indexedInputs = abi.inputs.filter(input => input.indexed)
    return indexedInputs.map(indexedInput => {
      const { name } = indexedInput
      if (isUndefined(indexFilterValues[name])) {
        return null
      }
      const value = indexFilterValues[name]
      const arrayish = utils.arrayify(value)
      // Zeros prepended to 32 bytes
      const padded = utils.padZeros(arrayish, 32)
      const topic = utils.hexlify(padded)
      return topic
    })
    // const topics = []
    // for (const eventInput of abi.inputs) {
    //   if (!eventInput.indexed) {
    //     continue
    //   }
    //   if (isUndefined(indexFilterValues[eventInput.name])) {
    //     topics.push(null)
    //   } else {
    //     const value = indexFilterValues[eventInput.name]
    //     const arrayish = utils.arrayify(value)
    //     const padded = utils.padZeros(arrayish, 32)
    //     const topic = utils.hexlify(padded)
    //     topics.push(topic)
    //   }
    // }
    // return topics
  }

  matchesFilter(log, filter) {
    if (!isUndefined(filter.address) && log.address !== filter.address) {
      return false
    }
    if (!isUndefined(filter.topics)) {
      return this.matchesTopics(log.topics, filter.topics)
    }
    return true
  }

  matchesTopics(logTopics, filterTopics) {
    const matchesTopic = zipWith(this.matchesTopic.bind(this), logTopics, filterTopics)
    const matchesTopics = every(matchesTopic)
    return matchesTopics
  }

  matchesTopic(logTopic, filterTopic) {
    if (isArray(filterTopic)) {
      return includes(logTopic, filterTopic)
    }
    if (isString(filterTopic)) {
      return filterTopic === logTopic
    }
    // null topic is a wildcard
    return true
  }
}

module.exports = EthEvents
