/** Trusted presentation code for batch desktops. Geometry and exports stay in the modeler's script. */
const PREPARE = `import bpy as _cs_bpy
if not _cs_bpy.app.driver_namespace.get('_chatspace_live_view'):
    _cs_bpy.context.preferences.view.show_splash = False
    try:
        import ctypes as _cs_ctypes
        _cs_x11 = _cs_ctypes.CDLL('libX11.so.6')
        _cs_x11.XOpenDisplay.argtypes = [_cs_ctypes.c_char_p]
        _cs_x11.XOpenDisplay.restype = _cs_ctypes.c_void_p
        _cs_x11.XKeysymToKeycode.argtypes = [_cs_ctypes.c_void_p, _cs_ctypes.c_ulong]
        _cs_x11.XKeysymToKeycode.restype = _cs_ctypes.c_ubyte
        _cs_x11.XFlush.argtypes = [_cs_ctypes.c_void_p]
        _cs_x11.XCloseDisplay.argtypes = [_cs_ctypes.c_void_p]
        _cs_display = _cs_x11.XOpenDisplay(None)
        if _cs_display:
            try:
                _cs_xtst = _cs_ctypes.CDLL('libXtst.so.6')
                _cs_xtst.XTestFakeKeyEvent.argtypes = [_cs_ctypes.c_void_p, _cs_ctypes.c_uint, _cs_ctypes.c_int, _cs_ctypes.c_ulong]
                _cs_key = _cs_x11.XKeysymToKeycode(_cs_display, 0xff1b)
                _cs_xtst.XTestFakeKeyEvent(_cs_display, _cs_key, 1, 0)
                _cs_xtst.XTestFakeKeyEvent(_cs_display, _cs_key, 0, 0)
                _cs_x11.XFlush(_cs_display)
            finally:
                _cs_x11.XCloseDisplay(_cs_display)
    except (OSError, AttributeError):
        print('ChatSpace: splash dismissal unavailable on this display')
    _cs_bpy.app.driver_namespace['_chatspace_live_view'] = True
`;
const FRAME = `
from mathutils import Vector as _cs_Vector
_cs_points = [_cs_obj.matrix_world @ _cs_Vector(_cs_corner)
    for _cs_obj in _cs_bpy.context.scene.objects if _cs_obj.type == 'MESH' and not _cs_obj.hide_viewport
    for _cs_corner in _cs_obj.bound_box]
if _cs_points:
    _cs_min = _cs_Vector(tuple(min(p[i] for p in _cs_points) for i in range(3)))
    _cs_max = _cs_Vector(tuple(max(p[i] for p in _cs_points) for i in range(3)))
    for _cs_window in _cs_bpy.context.window_manager.windows:
        for _cs_area in _cs_window.screen.areas:
            if _cs_area.type == 'VIEW_3D' and _cs_area.spaces.active.region_3d:
                _cs_region = _cs_area.spaces.active.region_3d
                _cs_region.view_location = (_cs_min + _cs_max) / 2
                _cs_region.view_distance = max((_cs_max - _cs_min).length * 1.8, 0.1)
                _cs_area.tag_redraw()
`;

export function withBatchViewport(code: string): string {
  // Compile separately so the modeler's script may still start with future imports.
  return `${PREPARE}\nexec(compile(${JSON.stringify(code)}, '<chatspace-modeler>', 'exec'), globals())\n${FRAME}`;
}
