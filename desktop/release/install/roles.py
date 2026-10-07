"""Persistent administrator-role contract; role assignment is not authentication."""
import json

SCHEMA_VERSION = 1
PRIMARY_ADMINISTRATOR = 1000
MANAGEMENT_OPERATIONS = frozenset({
    "accounts.password", "accounts.autologin", "accounts.roles",
    "apps.install", "apps.replace", "apps.uninstall",
    "system.maintain", "system.restore", "network.credentials",
})


def user_ids(values):
    if not isinstance(values, (list, tuple, set, frozenset)) or not 2 <= len(values) <= 256:
        raise ValueError("Expected qualified root and ordinary user identities")
    if any(type(value) is not int or (value != 0 and not 1000 <= value <= 65535) or
           value == 65534 for value in values) or len(set(values)) != len(values) or \
            not {0, PRIMARY_ADMINISTRATOR}.issubset(values):
        raise ValueError("Invalid or conflicting qualified user identity")
    return set(values)


def validate(policy, known_users):
    known = user_ids(known_users)
    if not isinstance(policy, dict) or set(policy) != {"schemaVersion", "administratorUids"} or \
            type(policy["schemaVersion"]) is not int or policy["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("Unsupported administrator policy")
    administrators = policy["administratorUids"]
    if not isinstance(administrators, list) or not 1 <= len(administrators) <= 255 or any(
            type(value) is not int or value not in known or value == 0 for value in administrators) or \
            len(set(administrators)) != len(administrators) or administrators != sorted(administrators):
        raise ValueError("Administrator policy needs unique qualified ordinary UIDs")
    return {"schemaVersion": SCHEMA_VERSION, "administratorUids": list(administrators)}


def parse(text, known_users):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate administrator policy field")
            result[key] = value
        return result

    return validate(json.loads(text, object_pairs_hook=unique), known_users)


def initial(known_users):
    return validate({"schemaVersion": SCHEMA_VERSION,
                     "administratorUids": [PRIMARY_ADMINISTRATOR]}, known_users)


def assigned_role(policy, uid, known_users):
    known = user_ids(known_users)
    policy = validate(policy, known)
    if type(uid) is not int or uid not in known:
        raise ValueError("Role query requires a qualified UID")
    if uid == 0:
        return "root"
    return "administrator" if uid in policy["administratorUids"] else "standard"


def management_eligible(policy, uid, operation, known_users):
    """Role eligibility only; a backend must still verify caller/session and PAM."""
    if not isinstance(operation, str) or operation not in MANAGEMENT_OPERATIONS:
        raise ValueError("Unknown or unrestricted management operation")
    return assigned_role(policy, uid, known_users) in {"root", "administrator"}
