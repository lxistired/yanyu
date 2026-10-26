"""Dependency-free synthetic exception tests; no recognition module is imported."""
import ast, contextlib, io, json, pathlib, sys, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'local-asr'))
from public_errors import public_error, _KNOWN_VALIDATION_ERRORS
class ErrorTests(unittest.TestCase):
    def test_unknown_diagnostics_never_serialized(self):
        secret='SYNTHETIC_SECRET_SENTINEL /private/synthetic/path'
        class Hostile(Exception):
            def __str__(self): raise AssertionError('must not stringify')
        for exc in [RuntimeError(secret),ValueError(secret),OSError(2,secret),Hostile(secret),ValueError({'secret':secret})]:
            out,err=io.StringIO(),io.StringIO()
            with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err): result=public_error(exc)
            self.assertEqual(result['error_code'],'ASR_FAILED')
            self.assertNotIn(secret,json.dumps(result));self.assertEqual(out.getvalue()+err.getvalue(),'')
    def test_exact_known_validation_codes_and_prefix_rejection(self):
        for message,code in _KNOWN_VALIDATION_ERRORS.items():
            self.assertEqual(public_error(ValueError(message))['error_code'],code)
            self.assertEqual(public_error(ValueError(message+' /private/SYNTHETIC_SECRET_SENTINEL'))['error_code'],'ASR_FAILED')
    def test_actual_worker_exception_handler_uses_safe_envelope(self):
        tree=ast.parse((ROOT/'local-asr/recognize_long.py').read_text())
        handler=next(n for n in tree.body if isinstance(n,ast.Try)).handlers[0]
        emitted=[]
        class Exit(Exception): pass
        class Sys:
            @staticmethod
            def exit(code): raise Exit(code)
        scope={'exc':RuntimeError('SYNTHETIC_SECRET_SENTINEL'),'emit':emitted.append,'public_error':public_error,'sys':Sys}
        with self.assertRaises(Exit): exec(compile(ast.Module(body=handler.body,type_ignores=[]),'worker-handler','exec'),scope)
        self.assertEqual(emitted,[public_error(scope['exc'])])
if __name__=='__main__': unittest.main()
