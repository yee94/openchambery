const COMMANDS_SAFE_FOR_REMOTE = new Set([
  'desktop_hosts_get',
  'desktop_host_probe',
  'desktop_new_window',
  'desktop_new_window_at_url',
  'desktop_new_window_for_host',
  'desktop_set_window_title',
  'desktop_set_window_theme',
  'desktop_is_window_fullscreen',
  'desktop_start_window_drag',
  'desktop_minimize_current_window',
  'desktop_toggle_current_window_maximized',
  'desktop_close_current_window',
  'desktop_get_current_window_state',
  'desktop_get_app_version',
  'desktop_get_lan_address',
  'desktop_capture_page_rect',
  'desktop_tray_update',
  'desktop_zoom_in',
  'desktop_zoom_out',
  'desktop_zoom_reset',
  'desktop_check_for_updates',
  'desktop_download_and_install_update',
]);

export const isRemoteIpcCommandAllowed = (command, args) => {
  if (COMMANDS_SAFE_FOR_REMOTE.has(command)) return true;
  return command === 'desktop_restart' && args?.applyUpdate === true;
};
