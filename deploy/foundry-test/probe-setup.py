#!/usr/bin/env python3
"""Read-only loopback setup probe. Never print cookies, form values or page bodies."""
import json
from html.parser import HTMLParser
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class FormSummary(HTMLParser):
    def __init__(self):
        super().__init__()
        self.forms = []
        self.fields = []
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self.forms.append({"actionPath": urlsplit(attrs.get("action", "")).path,
                               "method": attrs.get("method", "get")})
        elif tag in ("input", "select", "button"):
            self.fields.append({"tag": tag, "type": attrs.get("type", ""),
                                "name": attrs.get("name", ""), "id": attrs.get("id", "")})
        elif tag == "script" and attrs.get("src", "").startswith("/"):
            self.scripts.append(urlsplit(attrs["src"]).path)


def main():
    opener = build_opener(ProxyHandler({}), NoRedirect())
    path = "/"
    for _ in range(4):
        try:
            response = opener.open(Request("http://127.0.0.1:30000" + path), timeout=10)
        except HTTPError as error:
            response = error
        with response:
            if response.status in (301, 302, 303, 307, 308):
                location = urlsplit(response.headers.get("Location", ""))
                if location.scheme or location.netloc or not location.path.startswith("/") or location.query:
                    raise ValueError("Refusing non-local or parameterized redirect")
                print(json.dumps({"status": response.status, "path": path,
                                  "redirectPath": location.path}))
                path = location.path
                continue
            content = response.read(2 * 1024 * 1024 + 1)
            if len(content) > 2 * 1024 * 1024:
                raise ValueError("Setup response exceeds limit")
            summary = FormSummary()
            summary.feed(content.decode("utf-8"))
            print(json.dumps({"status": response.status, "path": path, "forms": summary.forms,
                              "fields": summary.fields, "scripts": summary.scripts}))
            return
    raise ValueError("Too many local redirects")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "Setup probe unavailable; no response body or secrets printed"}))
        raise SystemExit(1) from None
