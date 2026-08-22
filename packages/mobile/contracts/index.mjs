import { openChamberExternalBrowserContract } from './openchamber-external-browser.mjs'
import { openChamberHapticsContract } from './openchamber-haptics.mjs'
import { openChamberMediaContract } from './openchamber-media.mjs'
import { openChamberNavigationContract } from './openchamber-navigation.mjs'
import { openChamberShareContract } from './openchamber-share.mjs'
import { openChamberVirtualAssetContract } from './openchamber-virtual-asset.mjs'

/** All custom native bridge contracts checked by mobile-release-plan. */
export const mobileBridgeContracts = [
  openChamberShareContract,
  openChamberVirtualAssetContract,
  openChamberMediaContract,
  openChamberHapticsContract,
  openChamberNavigationContract,
  openChamberExternalBrowserContract,
]

export {
  openChamberExternalBrowserContract,
  openChamberHapticsContract,
  openChamberMediaContract,
  openChamberNavigationContract,
  openChamberShareContract,
  openChamberVirtualAssetContract,
}
