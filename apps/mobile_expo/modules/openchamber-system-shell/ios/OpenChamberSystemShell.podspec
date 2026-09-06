Pod::Spec.new do |s|
  s.name           = 'OpenChamberSystemShell'
  s.version        = '1.19.7-beta.7'
  s.summary        = 'OpenChamber Expo system shell native module'
  s.description    = 'Live Activity, App Group share store, virtual assets for Expo'
  s.license        = 'MIT'
  s.author         = 'yee94'
  s.homepage       = 'https://github.com/yee94/openchambery'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => 'https://github.com/yee94/openchambery.git' }
  s.static_framework = true
  s.source_files   = '**/*.{h,m,mm,swift}'
  s.frameworks     = 'UIKit', 'ActivityKit'
  s.dependency 'ExpoModulesCore'
end
