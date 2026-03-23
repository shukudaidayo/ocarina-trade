import { Buffer } from 'buffer'
globalThis.Buffer = Buffer

import './lib/appkit'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router'
import App from './app'
import Home from './pages/home'
import Create from './pages/create'
import Trade from './pages/trade'
import Offers from './pages/offers'
import './style.css'

const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'create', element: <Create /> },
      { path: 'trade/:chainId/:txHash', element: <Trade /> },
      { path: 'offers', element: <Offers /> },
    ],
  },
])

createRoot(document.getElementById('root')).render(<RouterProvider router={router} />)
