import { yuriComposerContract } from './yuri-composer.mjs'
import { yuriExternalBrowserContract } from './yuri-external-browser.mjs'
import { yuriHapticsContract } from './yuri-haptics.mjs'
import { yuriMediaContract } from './yuri-media.mjs'
import { yuriNavigationContract } from './yuri-navigation.mjs'
import { yuriShareContract } from './yuri-share.mjs'
import { yuriTabBarContract } from './yuri-tab-bar.mjs'
import { yuriVirtualAssetContract } from './yuri-virtual-asset.mjs'
import { yuriVideoContract } from './yuri-video.mjs'
import { yuriViewExportContract } from './yuri-view-export.mjs'

/** All custom native bridge contracts checked by mobile-release-plan. */
export const mobileBridgeContracts = [
  yuriShareContract,
  yuriVirtualAssetContract,
  yuriVideoContract,
  yuriMediaContract,
  yuriHapticsContract,
  yuriNavigationContract,
  yuriExternalBrowserContract,
  yuriComposerContract,
  yuriTabBarContract,
  yuriViewExportContract,
]

export {
  yuriComposerContract,
  yuriExternalBrowserContract,
  yuriHapticsContract,
  yuriMediaContract,
  yuriNavigationContract,
  yuriShareContract,
  yuriTabBarContract,
  yuriVirtualAssetContract,
  yuriVideoContract,
  yuriViewExportContract,
}
