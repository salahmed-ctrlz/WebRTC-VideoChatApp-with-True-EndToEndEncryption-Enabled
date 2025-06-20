## 📁 Repository Name:

**WebRTC-VideoChatApp-with-True-EndToEndEncryption-Enabled**

---

## 📝 Description:

> A browser-based WebRTC application that enables secure, real-time video and chat using **End-to-End Encryption (E2EE)**.
> Built with **Insertable Streams**, **ECDH key exchange**, and **AES-GCM encryption**, this project demonstrates secure peer-to-peer communication without server-side access to media.

---

## 📂 Project Structure

```
/public
├── client.js         → Frontend logic (WebRTC, encryption, UI events)
├── index.html        → Web UI layout
├── style.css         → Custom styles for the application

package.json          → Project dependencies
package-lock.json     → Lock file for dependencies
server.js             → Node.js + Socket.IO signaling server
```

---

## 🚀 Features

* 🔐 End-to-end encrypted **video** and **chat**
* 🔑 **ECDH key exchange** using the Web Crypto API
* 🔒 **AES-GCM media encryption** via Insertable Streams
* 🌐 Real-time 1:1 **WebRTC connection**
* 🗂️ Stateless **signaling server** using **Socket.IO**
* ⚙️ Modular and browser-native implementation

---

## 🛠️ Technologies Used

| Area                | Stack                                     |
| ------------------- | ----------------------------------------- |
| **Frontend**        | HTML, CSS, JavaScript                     |
| **WebRTC**          | RTCPeerConnection, Insertable Streams API |
| **Encryption**      | AES-GCM, ECDH (Web Crypto API)            |
| **Backend**         | Node.js, Express, Socket.IO               |
| **Auth (optional)** | JWT (JSON Web Tokens)                     |

---

## 🧠 Project Background

> This application was developed as part of a Master’s thesis project:
> **“Implementation of an End-to-End Encryption Mechanism in WebRTC Video Streaming”**
> 🎓 Authors: Medkour Salah Eddine & Arab Idris
> 👩‍🏫 Supervisor: Dr. Mechouek Khaoula
> 🏛️ University: Badji Mokhtar University – Annaba

---

## 🧩 Getting Started

```bash
npm install
node server.js
```

Then open `http://localhost:3000` in two separate browser tabs or devices.

---

Author: Salah Eddine Medkour @salahmed-ctrlz
