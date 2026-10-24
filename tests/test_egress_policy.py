import importlib.util
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('egress_policy', Path(__file__).resolve().parents[1] / '.devcontainer/egress/policy.py')
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)


class EgressPolicyTests(unittest.TestCase):
    def test_canonical_dns_names_and_https_authorities(self):
        self.assertEqual(policy.hostname('API.GitHub.com.'), 'api.github.com')
        self.assertEqual(policy.authority('api.github.com:443'), ('api.github.com', 443))

    def test_rejects_ambiguous_names_and_ip_literals(self):
        for value in ['127.0.0.1', '169.254.169.254', '::1', '[::1]', 'user@api.github.com', 'api.github.com/path', '*.github.com', '', 'a..b']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                policy.hostname(value)

    def test_rejects_private_shared_and_metadata_addresses(self):
        for value in ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1']:
            self.assertFalse(policy.public_address(value), value)
        self.assertTrue(policy.public_address('1.1.1.1'))

    def test_resolution_is_pinned_and_rejects_mixed_private_answers(self):
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('1.1.1.1', 443))]
        with patch.object(policy.socket, 'getaddrinfo', return_value=answers):
            self.assertEqual(policy.resolve_public('allowed.invalid'), '1.1.1.1')
        answers.append((socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443)))
        with patch.object(policy.socket, 'getaddrinfo', return_value=answers):
            with self.assertRaises(ValueError):
                policy.resolve_public('allowed.invalid')


if __name__ == '__main__':
    unittest.main()
