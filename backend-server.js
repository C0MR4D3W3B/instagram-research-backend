const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// API Base URL
const API_BASE_URL = 'https://rest.gohighlevel.com/v1';
const API_ACCESS_TOKEN = process.env.API_ACCESS_TOKEN;

app.use(cors());
app.use(bodyParser.json());

// --- Authentication Endpoints ---
app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    try {
        let contact = await findContactByEmail(email);

        if (!contact) {
            contact = await createContact(email, password);
            if (!contact) {
                return res.status(500).json({ success: false, message: 'Failed to create contact' });
            }
        }

        const token = 'dummy_jwt_token_for_' + contact.id;
        res.json({ 
            success: true, 
            message: 'Login successful', 
            token, 
            user: { 
                email: contact.email, 
                id: contact.id, 
                subscriptionTier: contact.customFields?.subscription_tier || 'Individual' 
            } 
        });

});

app.post('/auth/verify', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Authorization token required' });
    }
    const token = authHeader.split(' ')[1];

    if (token.startsWith('dummy_jwt_token_for_')) {
        const contactId = token.split('_').pop();
        const contact = await getContactById(contactId);
        if (contact) {
            return res.json({ 
                success: true, 
                message: 'Token valid', 
                user: { 
                    email: contact.email, 
                    id: contact.id, 
                    subscriptionTier: contact.customFields?.subscription_tier || 'Individual' 
                } 
            });
        }
    }
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
});

app.get('/user/info', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Authorization token required' });
    }
    const token = authHeader.split(' ')[1];

    if (token.startsWith('dummy_jwt_token_for_')) {
        const contactId = token.split('_').pop();
        const contact = await getContactById(contactId);
        if (contact) {
            return res.json({ 
                success: true, 
                user: { 
                    email: contact.email, 
                    id: contact.id, 
                    subscriptionTier: contact.customFields?.subscription_tier || 'Individual' 
                } 
            });
        }
    }
    res.status(401).json({ success: false, message: 'Invalid token or user not found' });
});

// Create new contact (signup)
app.post('/auth/signup', async (req, res) => {
    try {
        const { email, password, firstName, lastName, plan } = req.body;
        
        if (!email || !password || !firstName || !lastName) {
            return res.status(400).json({ 
                success: false, 
                message: 'All fields are required' 
            });
        }
        
        // Create contact in GoHighLevel
        const contact = await createContact(email, password, firstName, lastName, plan);
        
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

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
