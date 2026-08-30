import { openChamberComposerContract } from './openchamber-composer.mjs'
import { openChamberExternalBrowserContract } from './openchamber-external-browser.mjs'
import { openChamberHapticsContract } from './openchamber-haptics.mjs'
import { openChamberMediaContract } from './openchamber-media.mjs'
import { openChamberNavigationContract } from './openchamber-navigation.mjs'
import { openChamberShareContract } from './openchamber-share.mjs'
import { openChamberTabBarContract } from './openchamber-tab-bar.mjs'
import { openChamberVirtualAssetContract } from './openchamber-virtual-asset.mjs'

/** All custom native bridge contracts checked by mobile-release-plan. */
export const mobileBridgeContracts = [
  openChamberShareContract,
  openChamberVirtualAssetContract,
  openChamberMediaContract,
  openChamberHapticsContract,
  openChamberNavigationContract,
  openChamberExternalBrowserContract,
  openChamberComposerContract,
  openChamberTabBarContract,
]

export {
  openChamberComposerContract,
  openChamberExternalBrowserContract,
  openChamberHapticsContract,
  openChamberMediaContract,
  openChamberNavigationContract,
  openChamberShareContract,
  openChamberTabBarContract,
  openChamberVirtualAssetContract,
}
