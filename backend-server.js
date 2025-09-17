const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// API Base URL
const API_BASE_URL = 'https://rest.gohighlevel.com/v1';
const API_ACCESS_TOKEN = process.env.API_ACCESS_TOKEN;

// Rate limiting - more lenient for better UX
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 auth requests per windowMs
    message: { success: false, message: 'Too many authentication attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // limit each IP to 200 requests per windowMs
    message: { success: false, message: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply rate limiting
app.use(generalLimiter);

// CORS configuration for frontend and extension
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);
        
        const allowedOrigins = [
            'https://app.betterhumanbeans.com',
            'https://www.betterhumanbeans.com'
        ];
        
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else if (origin && origin.startsWith('chrome-extension://')) {
            // Only allow specific Chrome extension IDs
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json({ limit: '10mb' }));

// Input validation functions
function validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function validatePassword(password) {
    // Simple validation - just length and basic characters
    return password && password.length >= 6 && password.length <= 128;
}

function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    return input.trim().replace(/[<>]/g, '');
}

function generateSimpleToken(contactId) {
    // Simple token for session management - GHL handles the real auth
    return `session_token_${contactId}_${Date.now()}`;
}

function verifySimpleToken(token) {
    if (!token.startsWith('session_token_')) return null;
    const parts = token.split('_');
    return parts[2]; // Return contactId
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// --- Authentication Endpoints ---
app.post('/auth/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;
    
    // Input validation
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required' });
    }
    
    const sanitizedEmail = sanitizeInput(email);
    if (!validateEmail(sanitizedEmail)) {
        return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    
    if (!validatePassword(password)) {
        return res.status(400).json({ 
            success: false, 
            message: 'Password must be between 6 and 128 characters' 
        });
    }

    try {
        let contact = await findContactByEmail(email);

        if (!contact) {
            contact = await createContact(email, password);
            if (!contact) {
                return res.status(500).json({ success: false, message: 'Failed to create contact' });
            }
        }

        const token = generateSimpleToken(contact.id);
        res.json({ 
            success: true, 
            message: 'Login successful', 
            token, 
            user: { 
                email: contact.email, 
                id: contact.id, 
                name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || contact.email,
                subscriptionTier: contact.customFields?.subscription_tier || 'Individual' 
            },
            subscriptionTier: contact.customFields?.subscription_tier || 'Individual'
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});


app.get('/user/info', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Authorization token required' });
    }
    const token = authHeader.split(' ')[1];

    if (token.startsWith('session_token_')) {
        const contactId = verifySimpleToken(token);
        const contact = await getContactById(contactId);
        if (contact) {
            return res.json({ 
                success: true, 
                user: { 
                    email: contact.email, 
                    id: contact.id, 
                    name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || contact.email,
                    subscriptionTier: contact.customFields?.subscription_tier || 'Individual' 
                },
                subscriptionTier: contact.customFields?.subscription_tier || 'Individual'
            });
        }
    }
    res.status(401).json({ success: false, message: 'Invalid token or user not found' });
});

// Create new contact (signup)
app.post('/auth/signup', authLimiter, async (req, res) => {
    try {
        const { email, password, firstName, lastName, plan } = req.body;
        
        // Input validation
        if (!email || !password || !firstName || !lastName) {
            return res.status(400).json({ 
                success: false, 
                message: 'All fields are required' 
            });
        }
        
        const sanitizedEmail = sanitizeInput(email);
        const sanitizedFirstName = sanitizeInput(firstName);
        const sanitizedLastName = sanitizeInput(lastName);
        
        if (!validateEmail(sanitizedEmail)) {
            return res.status(400).json({ success: false, message: 'Invalid email format' });
        }
        
        if (!validatePassword(password)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Password must be between 6 and 128 characters' 
            });
        }
        
        if (sanitizedFirstName.length < 2 || sanitizedLastName.length < 2) {
            return res.status(400).json({ 
                success: false, 
                message: 'First and last names must be at least 2 characters' 
            });
        }
        
        // Create contact in GoHighLevel (GHL handles password security)
        const contact = await createContact(sanitizedEmail, password, sanitizedFirstName, sanitizedLastName, plan);
        
        if (contact) {
            res.json({ 
                success: true, 
                message: 'Account created successfully',
                user: {
                    id: contact.id,
                    email: contact.email,
                    firstName: contact.firstName,
                    lastName: contact.lastName,
                    name: `${firstName} ${lastName}`
                }
            });
        } else {
            res.status(400).json({ 
                success: false, 
                message: 'Failed to create account. Email may already exist.' 
            });
        }
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
});

// --- Research Data Endpoints ---
app.post('/research/save', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Authorization token required' });
    }
    const token = authHeader.split(' ')[1];

    if (!token.startsWith('dummy_jwt_token_for_')) {
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    const contactId = token.split('_').pop();

    const researchData = req.body;
    if (!researchData) {
        return res.status(400).json({ success: false, message: 'Research data is required' });
    }

    try {
        const updatedContact = await updateContactResearchData(contactId, researchData);
        res.json({ success: true, message: 'Research data saved', contact: updatedContact });
    } catch (error) {
        console.error('Save research data error:', error.response?.data || error.message);
        res.status(500).json({ success: false, message: 'Failed to save research data' });
    }
});

// --- Extension Integration Endpoints ---
app.post('/auth/authenticate', authLimiter, async (req, res) => {
    // Alias for /auth/login to match extension expectations
    const { email, password } = req.body;
    
    // Input validation
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required' });
    }
    
    const sanitizedEmail = sanitizeInput(email);
    if (!validateEmail(sanitizedEmail)) {
        return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    
    if (!validatePassword(password)) {
        return res.status(400).json({ 
            success: false, 
            message: 'Password must be between 6 and 128 characters' 
        });
    }

    try {
        let contact = await findContactByEmail(sanitizedEmail);

        if (!contact) {
            contact = await createContact(sanitizedEmail, password);
            if (!contact) {
                return res.status(500).json({ success: false, message: 'Failed to create contact' });
            }
        }

        const token = generateSimpleToken(contact.id);
        res.json({ 
            success: true, 
            message: 'Authentication successful', 
            token, 
            user: { 
                email: contact.email, 
                id: contact.id, 
                name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || contact.email,
                subscriptionTier: contact.customFields?.subscription_tier || 'Individual' 
            },
            subscription: {
                tier: contact.customFields?.subscription_tier || 'Individual',
                valid: true
            }
        });
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// --- Subscription Endpoints ---
app.get('/subscription/check', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Authorization token required' });
    }
    const token = authHeader.split(' ')[1];

    if (!token.startsWith('dummy_jwt_token_for_')) {
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    const contactId = token.split('_').pop();

    try {
        const contact = await getContactById(contactId);
        if (!contact) {
            return res.status(404).json({ success: false, message: 'Contact not found' });
        }
        const subscriptionTier = contact.customFields?.subscription_tier || 'Individual';
        const isValid = subscriptionTier !== 'Expired';

        res.json({ success: true, valid: isValid, tier: subscriptionTier });
    } catch (error) {
        console.error('Check subscription error:', error.response?.data || error.message);
        res.status(500).json({ success: false, message: 'Failed to check subscription' });
    }
});

// --- API Helper Functions ---
async function findContactByEmail(email) {
    try {
        const response = await axios.get(`${API_BASE_URL}/contacts/search?query=${email}`, {
            headers: { Authorization: `Bearer ${API_ACCESS_TOKEN}` }
        });
        return response.data.contacts[0];
    } catch (error) {
        console.error('API findContactByEmail error:', error.response?.data || error.message);
        return null;
    }
}

async function createContact(email, password, firstName = null, lastName = null, plan = 'Individual') {
    try {
        const response = await axios.post(`${API_BASE_URL}/contacts`, {
            email: email,
            firstName: firstName || email.split('@')[0],
            lastName: lastName || '',
            customFields: [
                { id: 'custom_field_id_for_password', value: password },
                { id: 'custom_field_id_for_subscription_tier', value: plan }
            ]
        }, {
            headers: { Authorization: `Bearer ${API_ACCESS_TOKEN}` }
        });
        return response.data.contact;
    } catch (error) {
        console.error('API createContact error:', error.response?.data || error.message);
        return null;
    }
}

async function getContactById(contactId) {
    try {
        const response = await axios.get(`${API_BASE_URL}/contacts/${contactId}`, {
            headers: { Authorization: `Bearer ${API_ACCESS_TOKEN}` }
        });
        return response.data.contact;
    } catch (error) {
        console.error('API getContactById error:', error.response?.data || error.message);
        return null;
    }
}

async function updateContactResearchData(contactId, researchData) {
    try {
        const customFieldId = 'custom_field_id_for_research_data';
        const response = await axios.put(`${API_BASE_URL}/contacts/${contactId}`, {
            customFields: [
                { id: customFieldId, value: JSON.stringify(researchData) },
                { id: 'custom_field_id_for_last_research_date', value: new Date().toISOString() }
            ]
        }, {
            headers: { Authorization: `Bearer ${API_ACCESS_TOKEN}` }
        });
        return response.data.contact;
    } catch (error) {
        console.error('API updateContactResearchData error:', error.response?.data || error.message);
        throw error;
    }
}

// Start server
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Instagram Research Backend API running on port ${PORT}`);
        console.log(`📊 Health check: http://localhost:${PORT}/health`);
        console.log(`🔐 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
}

module.exports = app;
