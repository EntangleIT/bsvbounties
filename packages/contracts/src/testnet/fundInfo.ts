import { fundInfo } from './wallet.js'
import { networkName } from './config.js'

const info = await fundInfo()
console.log(JSON.stringify({ reportedNetwork: networkName(), ...info }, null, 2))
