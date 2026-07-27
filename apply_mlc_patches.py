"""
Re-apply all mlc_llm compiler pass no-op patches.
These are needed each time the container restarts since the container's
/opt/venv directory is not volume-mounted.

=== To compile a NEW MLC model (convert_weight + gen_config + compile) ===
Use edge_agent:v2 (NOT v2-vllm) — it has the original TVM env that supports
mlc_llm convert_weight without the libtvm_ffi.so compatibility conflict.

Example:
  docker run --rm --gpus all \\
    -v /path/to/edge-agent-jp7/data:/data \\
    -v /path/to/edge-agent-jp7:/opt/NanoLLM \\
    edge_agent:v2 \\
    bash -c "
      python3 -m mlc_llm convert_weight <hf_dir> --quantization q4f16_1 --output <out_dir>
      python3 -m mlc_llm gen_config <hf_dir> --quantization q4f16_1 --conv-template <tmpl> \\
              --context-window-size <ctx> --output <out_dir>
      python3 /opt/NanoLLM/apply_mlc_patches.py
      python3 -m mlc_llm compile <out_dir>/mlc-chat-config.json --device cuda \\
              --opt 'flashinfer=0;cublas_gemm=0;faster_transformer=0;cudagraph=0;cutlass=1' \\
              --output <out_dir>/<model>-cuda.so
    "

Why: edge_agent:v2-vllm has a libtvm_ffi.so version conflict:
  - inference version (f37556): libmlc_llm.so loads OK, but tvm.ir.DictAttrs fails
  - compile version (069ab7): libmlc_llm.so undefined symbol (level_strings_)
  edge_agent:v2 has neither vLLM nor this conflict.
"""
import os, re, sys

BASE = '/opt/venv/lib/python3.12/site-packages/mlc_llm/compiler_pass'
MARKER = '# disabled: sblock API'
NOOP_MOD = '        return mod  # disabled: sblock API\n'

def noop_transform_module(filepath):
    with open(filepath) as f:
        lines = f.readlines()

    if any('# disabled: sblock API' in l for l in lines):
        print(f'  SKIP (already patched): {filepath.split("/")[-1]}')
        return

    method_line = None
    for i, line in enumerate(lines):
        if re.search(r'def transform_module\s*\(', line):
            method_line = i
            break

    if method_line is None:
        print(f'  ERROR: could not find transform_module in {filepath}')
        return

    # Find end of function signature: scan until line ending with ':'
    # Works for both single-line and multi-line signatures
    sig_end = method_line
    for i in range(method_line, min(method_line + 20, len(lines))):
        if lines[i].rstrip().endswith(':'):
            sig_end = i
            if i > method_line:
                break  # multi-line sig found its end
            # single-line sig: this is it
            break

    # Insert return mod immediately after signature (before body/docstring)
    insert_at = sig_end + 1
    method_indent = len(lines[method_line]) - len(lines[method_line].lstrip())
    body_indent = ' ' * (method_indent + 4)
    lines.insert(insert_at, body_indent + 'return mod  # disabled: sblock API\n')
    with open(filepath, 'w') as f:
        f.writelines(lines)
    print(f'  PATCHED: {filepath.split("/")[-1]} (no-op at line {insert_at + 1})')


files = [
    f'{BASE}/attach_softmax_with_temperature.py',
    f'{BASE}/attach_sampler.py',
    f'{BASE}/attach_spec_decode_aux_funcs.py',
    f'{BASE}/attach_logit_processor.py',
    f'{BASE}/low_batch_specialization.py',
    f'{BASE}/lift_global_buffer_alloc.py',
]

print('Applying no-op patches to mlc_llm compiler passes...')
for fp in files:
    try:
        noop_transform_module(fp)
    except Exception as e:
        print(f'  ERROR on {fp}: {e}')

# Also fix auto_target.py (CUDA compile hook)
auto_target = '/opt/venv/lib/python3.12/site-packages/mlc_llm/support/auto_target.py'
try:
    with open(auto_target) as f:
        content = f.read()

    changed = False
    if 'def tvm_callback_cuda_compile(code, target):' in content:
        content = content.replace(
            'def tvm_callback_cuda_compile(code, target):',
            'def tvm_callback_cuda_compile(code, target=None):'
        )
        changed = True
        print('  PATCHED: auto_target.py (target=None)')

    if 'from tvm.contrib import nvcc' in content:
        content = content.replace('from tvm.contrib import nvcc', 'from tvm.support import nvcc')
        changed = True
        print('  PATCHED: auto_target.py (tvm.support.nvcc)')

    if changed:
        with open(auto_target, 'w') as f:
            f.write(content)
    else:
        print('  SKIP: auto_target.py (already patched)')
except Exception as e:
    print(f'  ERROR on auto_target.py: {e}')

# Fix inner class transform() methods: 'return mod' → 'return self.mod'
# Happens when patch_file_simple inserts return inside _Rewriter.transform() instead of outer transform_module
print('Fixing inner class transform() methods...')
for fname in os.listdir(BASE):
    if not fname.endswith('.py'):
        continue
    path = os.path.join(BASE, fname)
    with open(path) as f:
        content = f.read()
    if MARKER not in content:
        continue
    lines = content.split('\n')
    changed = False
    for i, line in enumerate(lines):
        if MARKER in line and 'return mod' in line and 'return self.mod' not in line:
            for j in range(i - 1, max(i - 20, -1), -1):
                m = re.match(r'\s*def (\w+)\s*\(', lines[j])
                if m:
                    func_name = m.group(1)
                    if func_name == 'transform':
                        lines[i] = lines[i].replace('return mod', 'return self.mod')
                        print(f'  FIXED {fname}:{i+1}: return mod → return self.mod')
                        changed = True
                    break
    if changed:
        with open(path, 'w') as f:
            f.write('\n'.join(lines))

# Fix pipeline.py: wrap FuseAddRMSNorm in try-except so SM110 compile continues
# even if the sblock_alloc_buffer-based fused kernel fails (replicates original behavior)
pipeline_path = '/opt/venv/lib/python3.12/site-packages/mlc_llm/compiler_pass/pipeline.py'
_PIPELINE_OLD = '                    FuseAddRMSNorm(target=target)\n                    if target.kind.name != "llvm"\n                    else tvm.transform.Sequential([])'
_PIPELINE_NEW = '                    _TryFuseAddRMSNorm(target)\n                    if target.kind.name != "llvm"\n                    else tvm.transform.Sequential([])'
_PIPELINE_HELPER = '''
def _TryFuseAddRMSNorm(target):
    inner = FuseAddRMSNorm(target=target)
    @tvm.transform.module_pass(opt_level=0, name="TryFuseAddRMSNorm")
    def _impl(mod, ctx):
        try:
            return inner.transform_module(mod, ctx)
        except Exception:
            return mod
    return _impl

'''
try:
    with open(pipeline_path) as f:
        content = f.read()
    if '_TryFuseAddRMSNorm' in content:
        print('  SKIP: pipeline.py (already patched)')
    elif _PIPELINE_OLD in content:
        content = content.replace(_PIPELINE_OLD, _PIPELINE_NEW)
        insert_at = content.find('\ndef _build_pipeline(')
        if insert_at == -1:
            # Insert after logger line, before any @decorator or class
            insert_at = content.find('\nlogger = logging.getLogger')
            if insert_at != -1:
                insert_at = content.find('\n', insert_at + 1)  # end of logger line
        if insert_at == -1:
            insert_at = content.find('\nclass ')
        content = content[:insert_at] + _PIPELINE_HELPER + content[insert_at:]
        with open(pipeline_path, 'w') as f:
            f.write(content)
        print('  PATCHED: pipeline.py (FuseAddRMSNorm wrapped in try-except)')
    else:
        print('  SKIP: pipeline.py (pattern not found)')
except Exception as e:
    print(f'  ERROR on pipeline.py: {e}')

# Fix compiler_flags.py: set flashinfer default to False on SM110
# The installed flashinfer runtime API does not match the compile-time version,
# causing "Mismatched number of arguments" at inference time.
flags_path = '/opt/venv/lib/python3.12/site-packages/mlc_llm/interface/compiler_flags.py'
try:
    with open(flags_path) as f:
        content = f.read()
    _OLD = 'parser.add_argument("--flashinfer", type=boolean, default=True)'
    _NEW = 'parser.add_argument("--flashinfer", type=boolean, default=False)  # SM110: runtime API mismatch'
    if '# SM110: runtime API mismatch' in content:
        print('  SKIP: compiler_flags.py (already patched)')
    elif _OLD in content:
        content = content.replace(_OLD, _NEW)
        with open(flags_path, 'w') as f:
            f.write(content)
        print('  PATCHED: compiler_flags.py (flashinfer default=False)')
    else:
        print('  SKIP: compiler_flags.py (pattern not found)')
except Exception as e:
    print(f'  ERROR on compiler_flags.py: {e}')

# Revert any stale RTLD_DEEPBIND patch in mlc_llm/base.py (ineffective approach)
base_py = '/opt/venv/lib/python3.12/site-packages/mlc_llm/base.py'
try:
    with open(base_py) as f:
        content = f.read()
    _DEEPBIND_LINE = 'return ctypes.CDLL(lib_path[0], ctypes.RTLD_GLOBAL | 8), lib_path[0]  # RTLD_DEEPBIND(8): use RUNPATH, not global cache'
    _ORIG_LINE = 'return ctypes.CDLL(lib_path[0]), lib_path[0]'
    if _DEEPBIND_LINE in content:
        content = content.replace(_DEEPBIND_LINE, _ORIG_LINE)
        with open(base_py, 'w') as f:
            f.write(content)
        print('  REVERTED: mlc_llm/base.py (removed stale RTLD_DEEPBIND patch)')
    else:
        print('  SKIP: mlc_llm/base.py (no revert needed)')
except Exception as e:
    print(f'  ERROR on mlc_llm/base.py: {e}')

# Fix libtvm_ffi.so: vLLM installation replaces tvm_ffi/lib/libtvm_ffi.so with a newer
# version (069ab7, "compile version") that breaks libmlc_llm.so at runtime.
# The original version (f37556, "inference version") is needed for MLC runtime inference.
# Two backups are maintained:
#   libtvm_ffi.so.standalone_backup  = f37556  (inference: works with libmlc_llm.so + vllm)
#   libtvm_ffi.so.compile_backup     = 069ab7  (compilation: needed by mlc_llm compile pipeline)
# At container start, restore to inference version. To compile new models, swap temporarily.
import hashlib, shutil as _shutil
_TVM_FFI_SO       = '/opt/venv/lib/python3.12/site-packages/tvm_ffi/lib/libtvm_ffi.so'
_INFER_BACKUP     = '/opt/venv/lib/python3.12/site-packages/tvm_ffi/lib/libtvm_ffi.so.standalone_backup'
_COMPILE_BACKUP   = '/opt/venv/lib/python3.12/site-packages/tvm_ffi/lib/libtvm_ffi.so.compile_backup'
_INFER_MD5        = 'f37556cc9c56497a278d61f6b2505118'
_COMPILE_MD5      = '069ab7cd0fe7dbcd23f746a0efc162f4'
try:
    def _md5(path):
        h = hashlib.md5()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(65536), b''):
                h.update(chunk)
        return h.hexdigest()

    if not os.path.exists(_INFER_BACKUP):
        print(f'  SKIP: libtvm_ffi.so.standalone_backup not found')
    elif _md5(_INFER_BACKUP) != _INFER_MD5:
        print(f'  SKIP: libtvm_ffi.so.standalone_backup has unexpected checksum')
    elif _md5(_TVM_FFI_SO) == _INFER_MD5:
        print(f'  SKIP: libtvm_ffi.so (already inference version)')
    else:
        _shutil.copy2(_INFER_BACKUP, _TVM_FFI_SO)
        print(f'  PATCHED: libtvm_ffi.so restored to inference version (f37556)')
except Exception as e:
    print(f'  ERROR on libtvm_ffi.so: {e}')

print('Done.')
