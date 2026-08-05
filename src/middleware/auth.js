module.exports = function requireAuth(req, res, next) {
  const token = process.env.API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'NO_SERVER_TOKEN', message: 'API_TOKEN no configurado en el servidor.' });
  }
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (provided !== token) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Token inválido.' });
  }
  next();
};