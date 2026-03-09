# WhatsApp API Documentation

This API allows interaction with WhatsApp using HTTP requests.

## Authentication

All endpoints (except `/` and `/telegram-webhook`) are protected with **Basic Authentication**.

- **Header**: `Authorization: Basic <base64(USERNAME:PASSWORD)>`
- **Default Username**: `admin`
- **Default Password**: `admin123` *(Configurable via `.env` with `BASIC_AUTH_USER` and `BASIC_AUTH_PASS`)*

If authentication is missing or invalid, the server will return a `401 Unauthorized` response.

---

## Endpoints

### 1. View Dashboard & QR Code
- **Endpoint**: `/`
- **Method**: `GET`
- **Description**: Returns the web interface (HTML) to scan the QR code and monitor server logs.
- **Auth Required**: No

### 2. Send Message to Number
- **Endpoint**: `/send-message`
- **Method**: `POST`
- **Description**: Send a text message to a specific WhatsApp number.
- **Auth Required**: Yes
- **Body (JSON)**:
  ```json
  {
    "number": "6281234567890",
    "message": "Hello from API!"
  }
  ```
- **Responses**:
  - `200 OK`: `{"status": true, "response": {...}}`
  - `400 Bad Request`: Validation errors (e.g., missing fields, invalid number format, client not connected).

### 3. Send Message to Group
- **Endpoint**: `/send-message-group`
- **Method**: `POST`
- **Description**: Send a text message to a specific WhatsApp group.
- **Auth Required**: Yes
- **Body (JSON)**:
  ```json
  {
    "group_id": "1234567890-123456@g.us",
    "message": "Hello Group!"
  }
  ```
- **Responses**:
  - `200 OK`: `{"status": true, "response": {...}}`
  - `400 Bad Request`: Missing fields or client not connected.

### 4. Send Media to Number
- **Endpoint**: `/send-media`
- **Method**: `POST`
- **Description**: Send media (image/document) to a specific number using a file upload or a URL.
- **Auth Required**: Yes
- **Content-Type**: `multipart/form-data`
- **Fields**:
  - `number` (Text): Target phone number.
  - `caption` (Text - Optional): Message caption.
  - `url` (Text - Optional): URL of the media.
  - `media` (File - Optional): The file to upload (required if `url` is not provided).
- **Responses**:
  - `200 OK`: `{"status": true, "response": {...}}`
  - `400 Bad Request`: Missing fields.
  - `500 Server Error`: Processing failure.

### 5. Send Media to Group
- **Endpoint**: `/send-media-group`
- **Method**: `POST`
- **Description**: Send media (image/document) to a group using a file upload or a URL.
- **Auth Required**: Yes
- **Content-Type**: `multipart/form-data`
- **Fields**:
  - `group_id` (Text): Target Group ID.
  - `caption` (Text - Optional): Message caption.
  - `url` (Text - Optional): URL of the media.
  - `media` (File - Optional): The file to upload (required if `url` is not provided).
- **Responses**:
  - `200 OK`: `{"status": true, "response": {...}}`

### 6. List Group Members
- **Endpoint**: `/list-member-group`
- **Method**: `POST`
- **Description**: Get a list of all participants in a specific group.
- **Auth Required**: Yes
- **Body (JSON)**:
  ```json
  {
    "group_id": "1234567890-123456@g.us"
  }
  ```
- **Responses**:
  - `200 OK (Found)`: `{"status": true, "message": "Group Found.", "data": [...]}`
  - `200 OK (Not Found)`: `{"status": false, "message": "Group Not Found."}`

### 7. Add Member to Group
- **Endpoint**: `/add-member-group`
- **Method**: `POST`
- **Description**: Add a specific number to a group.
- **Auth Required**: Yes
- **Body (JSON)**:
  ```json
  {
    "group_id": "1234567890-123456@g.us",
    "number": "6281234567890"
  }
  ```
- **Responses**:
  - `200 OK`: `{"status": true, "message": "Success Add participants."}`

### 8. Remove Member from Group
- **Endpoint**: `/remove-member-group`
- **Method**: `POST`
- **Description**: Remove a specific number from a group.
- **Auth Required**: Yes
- **Body (JSON)**:
  ```json
  {
    "group_id": "1234567890-123456@g.us",
    "number": "6281234567890"
  }
  ```

### 9. Send Group Invitation Link
- **Endpoint**: `/send-invitation-link`
- **Method**: `POST`
- **Description**: Generate an invite link for a group and send it to a specific number.
- **Auth Required**: Yes
- **Body (JSON)**:
  ```json
  {
    "group_id": "1234567890-123456@g.us",
    "number": "6281234567890"
  }
  ```

### 10. Check Group Info / Name
- **Endpoint**: `/check-group-name`
- **Method**: `POST`
- **Description**: Get basic information about a group (name, id, total participants).
- **Auth Required**: Yes
- **Body (JSON)**:
  ```json
  {
    "group_id": "1234567890-123456@g.us"
  }
  ```

### 11. Rename Group
- **Endpoint**: `/rename-group`
- **Method**: `POST`
- **Description**: Update the group title/subject.
- **Auth Required**: Yes
- **Body (JSON)**:
  ```json
  {
    "group_id": "1234567890-123456@g.us",
    "new_name": "New Awesome Group Name"
  }
  ```

### 12. Telegram Webhook (Relay)
- **Endpoint**: `/telegram-webhook`
- **Method**: `POST`
- **Description**: Captures a payload from Telegram and relays it to an internal system (e.g., n8n webhook).
- **Auth Required**: No (Excluded from Basic Auth)
- **Body (JSON)**: *Any valid Telegram Event Payload*
- **Responses**:
  - `200 OK`: Payload received and relayed.

---

## Incoming Messages Event (Webhook)

When the WhatsApp client receives a new message, the server automatically fires an HTTP POST request to a statically defined webhook (`https://siva.sanf.co.id:5678/...`).

**Payload Sent:**
- `Content-Type: application/x-www-form-urlencoded`
- **Data**:
  - `from`: Sender ID
  - `message`: Message body text
  - `has_quote`: Boolean indicating if quoting a message
  - `quote_message_id`: ID of the quoted message
  - `quote_message`: Text of the quoted message
  - `media`: Base64 string of the media (if available)
  - `message_type`: Type of the media (`ptt` for voice notes, etc.)
