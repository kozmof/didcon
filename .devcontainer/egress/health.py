"""Healthy means the denial policy is active, not merely a listening socket."""
import http.client

connection = http.client.HTTPConnection('127.0.0.1', 443, timeout=2)
connection.request('CONNECT', 'example.invalid:443', headers={'Host': 'example.invalid:443'})
response = connection.getresponse()
assert response.status == 403 and response.getheader('X-Didcon-Denial'), 'Proxy denial policy is inactive'
connection.close()
