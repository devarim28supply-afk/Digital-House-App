// Gestr Lab Firebase (project: gestr-lab). These web keys are public by
// design — access is controlled by Firestore rules + your approval gate,
// not by hiding this config.
export const firebaseConfig = {
  apiKey: "AIzaSyBBsuRtclsxnCtRD6DFmBteMeGXACw92RU",
  authDomain: "gestr-lab.firebaseapp.com",
  projectId: "gestr-lab",
  storageBucket: "gestr-lab.firebasestorage.app",
  messagingSenderId: "29497424931",
  appId: "1:29497424931:web:bbeee563b84ac6eca6c596",
};

// The root owner — the only email that is owner-by-identity. Delegated admins
// get the `admin` role in their member record instead.
export const OWNER_EMAIL = "kaalobmoran@gmail.com";

// The five member abilities plus the delegated-admin flag. Stored per member
// as booleans under `roles`; the owner/admins set them in the admin panel.
export const ROLE_KEYS = [
  "moveThings",       // move furniture / monitors
  "useMachine",       // use the EC2 box directly (Blender, etc.)
  "invite",           // invite other people
  "develop",          // authorized to build/code the platform
  "controlNoApproval",// control the owner's shared screen without an allow prompt
  "admin",            // approve members + set roles (delegated admin)
];
