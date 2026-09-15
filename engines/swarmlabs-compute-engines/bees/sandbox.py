"""
Docker沙箱 — 安全执行用户代码
对标报告3.7/4.6
"""
import subprocess, json, os, tempfile, time

class DockerSandbox:
    """Docker沙箱——隔离执行用户提交的代码"""
    
    def __init__(self, image='python:3.12-slim', timeout=30, mem_limit='256m'):
        self.image = image
        self.timeout = timeout
        self.mem_limit = mem_limit
        self._check_docker()
    
    def _check_docker(self):
        """检查Docker是否可用"""
        try:
            r = subprocess.run(['docker', '--version'], capture_output=True, timeout=5)
            self.available = r.returncode == 0
        except:
            self.available = False
    
    def execute(self, code, stdin_data=None):
        """在Docker沙箱中执行代码
        返回: {stdout, stderr, exit_code, time, cached}
        """
        if not self.available:
            # 降级：受限exec（非Docker，标注风险）
            return self._fallback_exec(code, stdin_data)
        
        # 写代码到临时文件
        with tempfile.NamedTemporaryFile(suffix='.py', mode='w', delete=False) as f:
            f.write(code)
            code_file = f.name
        
        try:
            # Docker运行
            cmd = [
                'docker', 'run', '--rm',
                '--network=none',  # 网络隔离
                '--memory=' + self.mem_limit,  # 内存限制
                '--cpus=0.5',  # CPU限制
                '--read-only',  # 只读根文件系统
                '--tmpfs', '/tmp:rw,size=64m',  # 临时目录可写
                '-v', f'{code_file}:/code.py:ro',  # 挂载代码只读
                self.image,
                'python3', '/code.py'
            ]
            
            start = time.time()
            r = subprocess.run(
                cmd, 
                capture_output=True, 
                input=stdin_data.encode() if stdin_data else None,
                timeout=self.timeout,
                text=True
            )
            elapsed = round(time.time() - start, 2)
            
            return {
                'stdout': r.stdout[:5000],
                'stderr': r.stderr[:2000],
                'exit_code': r.returncode,
                'time': elapsed,
                'sandbox': 'docker',
                'network': 'isolated',
                'memory_limit': self.mem_limit
            }
        except subprocess.TimeoutExpired:
            return {'stdout': '', 'stderr': '执行超时', 'exit_code': -1, 'time': self.timeout, 'sandbox': 'docker'}
        except Exception as e:
            return {'stdout': '', 'stderr': str(e)[:100], 'exit_code': -1, 'sandbox': 'error'}
        finally:
            os.unlink(code_file)
    
    def _fallback_exec(self, code, stdin_data=None):
        """降级执行——受限环境（非Docker）"""
        # 限制：禁止import危险模块
        dangerous = ['os', 'subprocess', 'shutil', 'ctypes', 'socket', 'pickle']
        for mod in dangerous:
            if f'import {mod}' in code or f'from {mod}' in code:
                return {'stdout': '', 'stderr': f'安全限制: 禁止import {mod}', 'exit_code': -1, 'sandbox': 'restricted'}
        
        try:
            # 受限globals
            restricted_globals = {'__builtins__': {
                'print': print, 'range': range, 'len': len, 'int': int,
                'float': float, 'str': str, 'list': list, 'dict': dict,
                'sum': sum, 'abs': abs, 'round': round, 'min': min, 'max': max,
                'enumerate': enumerate, 'zip': zip, 'map': map, 'filter': filter,
                'sorted': sorted, 'reversed': reversed, 'any': any, 'all': all,
                'math': __import__('math'), 'json': __import__('json'),
            }}
            
            import io, contextlib
            stdout_buf = io.StringIO()
            with contextlib.redirect_stdout(stdout_buf):
                exec(code, restricted_globals)
            
            return {
                'stdout': stdout_buf.getvalue()[:5000],
                'stderr': '',
                'exit_code': 0,
                'sandbox': 'restricted_fallback',
                'warning': 'Docker未安装，使用受限exec降级'
            }
        except Exception as e:
            return {'stdout': '', 'stderr': str(e)[:200], 'exit_code': -1, 'sandbox': 'restricted_fallback'}

# 全局实例
sandbox = DockerSandbox()
