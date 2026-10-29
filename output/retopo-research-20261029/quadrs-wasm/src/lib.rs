use quadrs::{remesh, Mesh, RemeshOptions, RemeshTarget};
use std::alloc::{alloc, dealloc, Layout};

static mut OUT: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn alloc_bytes(n: usize) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align(n, 8).unwrap()) }
}

#[no_mangle]
pub extern "C" fn dealloc_bytes(p: *mut u8, n: usize) {
    unsafe { dealloc(p, Layout::from_size_align(n, 8).unwrap()) }
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    unsafe { OUT.as_ptr() }
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    unsafe { OUT.len() }
}

/// vertices: f64 xyz, faces: u32 triangle indices
#[no_mangle]
pub extern "C" fn run(vp: *const f64, vn: usize, ip: *const u32, tn: usize, target_faces: usize, seed: u64) -> i32 {
    let verts = unsafe { std::slice::from_raw_parts(vp, vn * 3) };
    let idx = unsafe { std::slice::from_raw_parts(ip, tn * 3) };
    let mut mesh = Mesh {
        vertices: Vec::with_capacity(vn),
        faces: Vec::with_capacity(tn),
    };
    for i in 0..vn {
        mesh.vertices.push(quadrs::Vec3::new(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]));
    }
    for i in 0..tn {
        mesh.faces.push(vec![idx[i * 3] as usize, idx[i * 3 + 1] as usize, idx[i * 3 + 2] as usize]);
    }
    let mut options = RemeshOptions::new(RemeshTarget::FaceCount(target_faces));
    options.seed = Some(seed);
    match remesh(&mesh, &options) {
        Ok(result) => {
            let mut out: Vec<u8> = Vec::new();
            out.extend_from_slice(&(result.mesh.vertices.len() as u32).to_le_bytes());
            for v in &result.mesh.vertices {
                out.extend_from_slice(&(v.x as f32).to_le_bytes());
                out.extend_from_slice(&(v.y as f32).to_le_bytes());
                out.extend_from_slice(&(v.z as f32).to_le_bytes());
            }
            out.extend_from_slice(&(result.mesh.faces.len() as u32).to_le_bytes());
            for f in &result.mesh.faces {
                out.extend_from_slice(&(f.len() as u32).to_le_bytes());
                for i in f {
                    out.extend_from_slice(&(*i as u32).to_le_bytes());
                }
            }
            unsafe { OUT = out };
            0
        }
        Err(_) => -1,
    }
}
